"""split_persona_from_assistant

Revision ID: 0dacee9f63b8
Revises: d7b3e1c05a92
Create Date: 2026-09-04 22:55:57.712989

Reverses the persona/agent merge, in the shape the v3 client needs: one assistant
per user that owns capability, and many personas that own presentation.

``agents`` held two unrelated things on one row. The capability half (model,
provider, tools, reasoning, memory) described what the assistant can do; the
presentation half (name, prompt, voice, avatar, character config) described how it
sounds. A conversation picked one agent and got both, so changing voice changed
model, and every "main agent" carried a private copy of a memory that should have
been shared.

After this migration:

* ``personas``   -- renamed from ``agents``, presentation only. IDS ARE PRESERVED.
* ``assistants`` -- new, exactly one row per user, capability plus the wake word.
* ``sub_agents`` -- new, task-only workers, fresh ids. They keep their own model
  because they run their own LLM loop, but lose ``memory``: the consolidation
  worker only ever joined through ``messages.agent_id``, which only ever held
  main-agent ids, so a sub-agent's memory could never be written.

The ids are preserved deliberately. Character assets live at
``data/character_assets/{id}/`` and the same id is embedded as a URL prefix inside
``character_config``. 8945eadfca8e and facf3c9e62a8 both re-keyed and each had to
hand-write a directory rename plus a structured JSON URL rewrite to compensate;
facf3c9e62a8 computed its data directory from a ``DATA_DIR`` environment variable
that ``core/paths.py`` never reads, so outside Docker it renamed nothing while
still dropping the table. A rename costs one statement and makes all of that
unnecessary. There is deliberately NO disk work here. Do not add any.

Lossy where it has to be: a user with several main agents keeps one set of
capability config, chosen by the winner rule in ``_winner_order_sql``. The other
agents' model, provider, tools and reasoning flags are discarded and cannot be
recovered by the downgrade. Memory is the exception -- every non-empty memory is
merged into the assistant's single document rather than dropped. The ownerless
``App Guide`` system agent is deleted, as 83e667457a0b:60 deleted ``Administrator``.
"""
import json
import logging
from typing import Optional, Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0dacee9f63b8'
down_revision: Union[str, Sequence[str], None] = 'd7b3e1c05a92'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")


MAX_MEMORY_CHARS = 4000

# Mirrors RESERVED_AGENT_NAMES in routers/agents.py. Compared case-insensitively so a
# seeded persona can never collide with a name the API would later refuse to save.
RESERVED_PERSONA_NAMES = {"administrator", "user", "app guide"}


def _winner_order_sql() -> str:
    """Rank a user's main agents: most messages, then most recent conversation, then id.

    Message count is the strongest available evidence of who the user actually talks
    to, and it is the same signal the memory worker already trusts when it decides
    which agents participated in a conversation.
    """
    return """
        SELECT a.id, a.name, a.model_name, a.provider_type, a.available_tools,
               a.think, a.use_deferred_tools, a.memory, a.memory_enabled, a.trigger_word
        FROM agents a
        WHERE a.user_id = :uid AND a.agent_type = 'main'
        ORDER BY (SELECT count(*) FROM messages m WHERE m.agent_id = a.id) DESC,
                 (SELECT max(c.updated_at) FROM conversations c
                   WHERE c.main_agent_id = a.id) DESC NULLS LAST,
                 a.id ASC
    """


def _merge_memories(rows) -> Optional[str]:
    """Fold every main agent's memory into the one document the assistant now owns.

    A user with exactly one non-empty memory keeps it verbatim: adding a header there
    would rewrite every existing single-agent user's memory for no gain, and the LLM
    consolidation would then perpetuate the header forever.
    """
    non_empty = [(r.name, (r.memory or "").strip()) for r in rows if (r.memory or "").strip()]
    if not non_empty:
        return None
    if len(non_empty) == 1:
        merged = non_empty[0][1]
    else:
        merged = "\n\n".join(f'## From "{name}"\n\n{mem}' for name, mem in non_empty)
    return merged[:MAX_MEMORY_CHARS]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    # The pre-merge `personas` table was dropped in facf3c9e62a8, and its downgrade
    # would recreate it. Refuse to run on a database where that happened.
    if "agents" not in tables:
        raise RuntimeError("expected an `agents` table to split; found none")
    if "personas" in tables:
        raise RuntimeError(
            "a `personas` table already exists — refusing to run. This migration renames "
            "`agents` to `personas`; an existing one means facf3c9e62a8 was downgraded."
        )

    # --- 0. Repair the invariant this migration depends on -------------------------
    # Sub-agents never author messages and are never bound to a conversation, so no FK
    # should point at one. The code guarantees it; forty-nine migrations of history do
    # not. Repair rather than trust, because step 3 deletes those rows outright and a
    # stale reference would become a dangling id after the rename.
    for table, column in (("messages", "agent_id"), ("conversations", "main_agent_id")):
        stale = bind.execute(
            sa.text(
                f"SELECT count(*) FROM {table} WHERE {column} IN "
                "(SELECT id FROM agents WHERE agent_type = 'sub')"
            )
        ).scalar_one()
        if stale:
            logger.warning(
                "%s.%s: %d row(s) reference a sub-agent; clearing before the split",
                table, column, stale,
            )
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET {column} = NULL WHERE {column} IN "
                    "(SELECT id FROM agents WHERE agent_type = 'sub')"
                )
            )

    # --- 1. Delete the App Guide system agent --------------------------------------
    # It has no owner, so it cannot become a per-user persona, and its capability
    # config cannot fold into anyone's assistant. 83e667457a0b:60 deleted the
    # Administrator agent the same way. Both FKs are ON DELETE SET NULL.
    deleted = bind.execute(
        sa.text("DELETE FROM agents WHERE is_system = true RETURNING name")
    ).fetchall()
    for row in deleted:
        logger.warning("deleted system agent %r — it cannot own an assistant", row.name)

    orphans = bind.execute(
        sa.text("SELECT count(*) FROM agents WHERE user_id IS NULL")
    ).scalar_one()
    if orphans:
        raise RuntimeError(
            f"{orphans} agent(s) still have no user_id after deleting system agents; "
            "personas.user_id is NOT NULL and there is no owner to assign"
        )

    # --- 2. Move sub-agents to their own table -------------------------------------
    # Fresh ids are safe: nothing references a sub-agent. They deliberately lose
    # `memory`/`memory_enabled` — the consolidation worker only ever joined through
    # messages.agent_id, which only ever held main-agent ids, so a sub-agent's memory
    # could never be written.
    op.create_table(
        "sub_agents",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), server_default="", nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("model_name", sa.String(), nullable=True),
        sa.Column("provider_type", sa.String(), server_default="ollama", nullable=False),
        sa.Column("available_tools", sa.JSON(), nullable=True),
        sa.Column("think", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("use_deferred_tools", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "name", name="uq_sub_agent_user_id_name"),
    )
    bind.execute(
        sa.text(
            """
            INSERT INTO sub_agents (user_id, name, description, system_prompt, model_name,
                                    provider_type, available_tools, think, use_deferred_tools,
                                    enabled, created_at)
            SELECT user_id, name, description, system_prompt, model_name, provider_type,
                   available_tools, think, use_deferred_tools, enabled, created_at
            FROM agents WHERE agent_type = 'sub'
            """
        )
    )
    bind.execute(sa.text("DELETE FROM agents WHERE agent_type = 'sub'"))

    # --- 3. Create `assistants` ----------------------------------------------------
    # default_persona_id is added without its FK: it points at `personas`, which does
    # not exist until the rename below.
    op.create_table(
        "assistants",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("model_name", sa.String(), nullable=True),
        sa.Column("provider_type", sa.String(), server_default="ollama", nullable=False),
        sa.Column("available_tools", sa.JSON(), nullable=True),
        sa.Column("think", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("use_deferred_tools", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("memory", sa.Text(), nullable=True),
        sa.Column("memory_enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("trigger_word", sa.String(), nullable=True),
        sa.Column("default_persona_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", name="uq_assistant_user_id"),
    )

    # --- 4. One assistant per user, from the winning main agent --------------------
    user_ids = [r.id for r in bind.execute(sa.text("SELECT id FROM users ORDER BY id"))]
    for uid in user_ids:
        mains = bind.execute(sa.text(_winner_order_sql()), {"uid": uid}).fetchall()
        winner = mains[0] if mains else None

        if winner is not None and len(mains) > 1:
            discarded = [
                (m.name, m.model_name) for m in mains[1:]
                if (m.model_name, m.provider_type, m.think, m.use_deferred_tools)
                != (winner.model_name, winner.provider_type, winner.think, winner.use_deferred_tools)
                or m.available_tools != winner.available_tools
            ]
            if discarded:
                logger.warning(
                    "user %d: keeping capability from %r (%s); discarding %s. "
                    "Per-agent model/tool config is not recoverable.",
                    uid, winner.name, winner.model_name,
                    ", ".join(f"{n} ({mn})" for n, mn in discarded),
                )

        bind.execute(
            sa.text(
                """
                INSERT INTO assistants (user_id, model_name, provider_type, available_tools,
                                        think, use_deferred_tools, memory, memory_enabled,
                                        trigger_word, default_persona_id, created_at)
                VALUES (:uid, :model_name, :provider_type, CAST(:available_tools AS json),
                        :think, :use_deferred_tools, :memory, :memory_enabled, :trigger_word,
                        :default_persona_id, now())
                """
            ),
            {
                "uid": uid,
                "model_name": winner.model_name if winner else None,
                "provider_type": winner.provider_type if winner else "ollama",
                "available_tools": (
                    json.dumps(winner.available_tools)
                    if winner is not None and winner.available_tools is not None
                    else None
                ),
                "think": winner.think if winner else False,
                "use_deferred_tools": winner.use_deferred_tools if winner else False,
                "memory": _merge_memories(mains),
                "memory_enabled": winner.memory_enabled if winner else True,
                "trigger_word": winner.trigger_word if winner else None,
                "default_persona_id": winner.id if winner else None,
            },
        )

    # --- 5. Seed a persona for users who have none ---------------------------------
    # NO_MAIN_AGENTS is a real state today. Without this, such a user logs in after the
    # migration and cannot send a message at all.
    for uid in user_ids:
        has_persona = bind.execute(
            sa.text("SELECT count(*) FROM agents WHERE user_id = :uid"), {"uid": uid}
        ).scalar_one()
        if has_persona:
            continue
        taken = {
            r.name.lower()
            for r in bind.execute(
                sa.text("SELECT name FROM agents WHERE user_id = :uid"), {"uid": uid}
            )
        } | RESERVED_PERSONA_NAMES
        name = "Assistant"
        suffix = 2
        while name.lower() in taken:
            name = f"Assistant {suffix}"
            suffix += 1
        prefs = bind.execute(
            sa.text(
                "SELECT system_prompt, preferred_name, agent_avatar_uuid "
                "FROM users WHERE id = :uid"
            ),
            {"uid": uid},
        ).one()
        new_id = bind.execute(
            sa.text(
                """
                INSERT INTO agents (user_id, name, description, system_prompt, preferred_name,
                                    avatar_uuid, agent_type, provider_type, enabled, is_system,
                                    think, use_deferred_tools, memory_enabled, created_at)
                VALUES (:uid, :name, '', :prompt, :preferred, :avatar, 'main', 'ollama',
                        true, false, false, false, true, now())
                RETURNING id
                """
            ),
            {
                "uid": uid,
                "name": name,
                "prompt": prefs.system_prompt or "",
                "preferred": prefs.preferred_name or None,
                "avatar": prefs.agent_avatar_uuid,
            },
        ).scalar_one()
        logger.warning("user %d had no main agent; seeded persona %r (id=%d)", uid, name, new_id)
        bind.execute(
            sa.text("UPDATE assistants SET default_persona_id = :pid WHERE user_id = :uid"),
            {"pid": new_id, "uid": uid},
        )

    # --- 6. Rename `agents` to `personas`, preserving ids --------------------------
    # The ids are load-bearing OFF the database: character assets live at
    # data/character_assets/{id}/ and the same id is embedded as a URL prefix inside
    # character_config JSON. 8945eadfca8e and facf3c9e62a8 each had to hand-write a
    # directory rename plus a structured URL rewrite because they re-keyed. A rename
    # costs one statement and makes all of that unnecessary — so there is deliberately
    # NO disk work in this migration. Do not add any.
    op.drop_constraint("fk_conversations_main_agent_id", "conversations", type_="foreignkey")
    op.drop_constraint("fk_messages_agent_id", "messages", type_="foreignkey")

    op.rename_table("agents", "personas")
    op.execute("ALTER INDEX agents_pkey RENAME TO personas_pkey")
    op.execute("ALTER SEQUENCE agents_id_seq RENAME TO personas_id_seq")
    op.execute(
        "ALTER TABLE personas RENAME CONSTRAINT agents_user_id_fkey TO personas_user_id_fkey"
    )
    op.execute(
        "ALTER TABLE personas RENAME CONSTRAINT uq_agent_user_id_name TO uq_persona_user_id_name"
    )

    # --- 7. Re-point the two FK columns, values untouched --------------------------
    op.alter_column("conversations", "main_agent_id", new_column_name="persona_id")
    op.alter_column("messages", "agent_id", new_column_name="persona_id")
    op.create_foreign_key(
        "fk_conversations_persona_id", "conversations", "personas",
        ["persona_id"], ["id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_messages_persona_id", "messages", "personas",
        ["persona_id"], ["id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_assistants_default_persona_id", "assistants", "personas",
        ["default_persona_id"], ["id"], ondelete="SET NULL",
    )

    # --- 8. Strip capability from personas -----------------------------------------
    for column in (
        "model_name", "provider_type", "available_tools", "think", "use_deferred_tools",
        "memory", "memory_enabled", "agent_type", "is_system", "trigger_word",
    ):
        op.drop_column("personas", column)

    # --- 9. user_id becomes owned, not optional ------------------------------------
    # An orphaned assistants row would permanently block re-creating that user's
    # assistant through UNIQUE(user_id), so the cascade is load-bearing rather than
    # hygiene. personas had no cascade at all; only the ORM relationship did.
    op.alter_column("personas", "user_id", existing_type=sa.Integer(), nullable=False)
    op.drop_constraint("personas_user_id_fkey", "personas", type_="foreignkey")
    op.create_foreign_key(
        "personas_user_id_fkey", "personas", "users", ["user_id"], ["id"], ondelete="CASCADE"
    )


def downgrade() -> None:
    """Fuse the three tables back into `agents`. Deliberately lossy.

    Every persona is stamped with the assistant's single capability config, because the
    per-agent values were discarded on the way up and no record of them survives. A user
    who had three main agents with three different models gets three personas that all
    claim the winner's model. The memory split is equally unrecoverable: the merged
    document is copied onto the winner and the others come back empty. The deleted App
    Guide system agent is not restored.
    """
    bind = op.get_bind()

    op.drop_constraint("fk_assistants_default_persona_id", "assistants", type_="foreignkey")
    op.drop_constraint("fk_conversations_persona_id", "conversations", type_="foreignkey")
    op.drop_constraint("fk_messages_persona_id", "messages", type_="foreignkey")

    op.add_column("personas", sa.Column("model_name", sa.String(), nullable=True))
    op.add_column(
        "personas",
        sa.Column("provider_type", sa.String(), server_default="ollama", nullable=False),
    )
    op.add_column("personas", sa.Column("available_tools", sa.JSON(), nullable=True))
    op.add_column(
        "personas", sa.Column("think", sa.Boolean(), server_default=sa.false(), nullable=False)
    )
    op.add_column(
        "personas",
        sa.Column("use_deferred_tools", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column("personas", sa.Column("memory", sa.Text(), nullable=True))
    op.add_column(
        "personas",
        sa.Column("memory_enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
    )
    op.add_column(
        "personas", sa.Column("agent_type", sa.String(), server_default="main", nullable=False)
    )
    op.add_column(
        "personas", sa.Column("is_system", sa.Boolean(), server_default=sa.false(), nullable=False)
    )
    op.add_column("personas", sa.Column("trigger_word", sa.String(), nullable=True))

    bind.execute(
        sa.text(
            """
            UPDATE personas p SET model_name = a.model_name,
                                  provider_type = a.provider_type,
                                  available_tools = a.available_tools,
                                  think = a.think,
                                  use_deferred_tools = a.use_deferred_tools,
                                  memory_enabled = a.memory_enabled,
                                  trigger_word = CASE WHEN a.default_persona_id = p.id
                                                      THEN a.trigger_word END,
                                  memory = CASE WHEN a.default_persona_id = p.id
                                                THEN a.memory END
            FROM assistants a WHERE a.user_id = p.user_id
            """
        )
    )

    op.alter_column("personas", "user_id", existing_type=sa.Integer(), nullable=True)
    op.drop_constraint("personas_user_id_fkey", "personas", type_="foreignkey")
    op.create_foreign_key("personas_user_id_fkey", "personas", "users", ["user_id"], ["id"])

    op.execute(
        "ALTER TABLE personas RENAME CONSTRAINT uq_persona_user_id_name TO uq_agent_user_id_name"
    )
    op.execute(
        "ALTER TABLE personas RENAME CONSTRAINT personas_user_id_fkey TO agents_user_id_fkey"
    )
    op.execute("ALTER SEQUENCE personas_id_seq RENAME TO agents_id_seq")
    op.execute("ALTER INDEX personas_pkey RENAME TO agents_pkey")
    op.rename_table("personas", "agents")

    bind.execute(
        sa.text(
            """
            INSERT INTO agents (user_id, name, description, system_prompt, model_name,
                                provider_type, available_tools, think, use_deferred_tools,
                                agent_type, enabled, is_system, memory_enabled, created_at)
            SELECT user_id, name, description, system_prompt, model_name, provider_type,
                   available_tools, think, use_deferred_tools, 'sub', enabled, false, true,
                   created_at
            FROM sub_agents
            """
        )
    )

    op.alter_column("conversations", "persona_id", new_column_name="main_agent_id")
    op.alter_column("messages", "persona_id", new_column_name="agent_id")
    op.create_foreign_key(
        "fk_conversations_main_agent_id", "conversations", "agents",
        ["main_agent_id"], ["id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_messages_agent_id", "messages", "agents", ["agent_id"], ["id"], ondelete="SET NULL"
    )

    op.drop_table("assistants")
    op.drop_table("sub_agents")
