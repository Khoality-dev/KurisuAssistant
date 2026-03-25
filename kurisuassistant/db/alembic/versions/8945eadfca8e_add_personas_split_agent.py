"""add_personas_split_agent

Revision ID: 8945eadfca8e
Revises: ba8f26108bf7
Create Date: 2026-03-24 23:59:59.758902

"""
from typing import Sequence, Union
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '8945eadfca8e'
down_revision: Union[str, Sequence[str], None] = 'ba8f26108bf7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create personas table, migrate identity fields from agents, add persona_id FK."""

    # 1. Create personas table
    op.create_table('personas',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('system_prompt', sa.Text(), nullable=True),
        sa.Column('voice_reference', sa.String(), nullable=True),
        sa.Column('avatar_uuid', sa.String(), nullable=True),
        sa.Column('character_config', sa.JSON(), nullable=True),
        sa.Column('preferred_name', sa.Text(), nullable=True),
        sa.Column('trigger_word', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'name', name='uq_persona_user_id_name'),
    )

    # 2. Add persona_id column to agents (nullable)
    op.add_column('agents', sa.Column('persona_id', sa.Integer(), nullable=True))

    # 3. Data migration: create a persona for each existing agent
    conn = op.get_bind()
    agents = conn.execute(sa.text(
        "SELECT id, user_id, name, system_prompt, voice_reference, avatar_uuid, "
        "character_config, preferred_name, trigger_word, created_at FROM agents"
    )).fetchall()

    for agent in agents:
        agent_id, user_id, name, system_prompt, voice_ref, avatar, char_config, pref_name, trigger, created = agent

        # Handle duplicate persona names within same user (shouldn't happen normally)
        persona_name = name
        existing = conn.execute(sa.text(
            "SELECT id FROM personas WHERE user_id = :uid AND name = :n"
        ), {"uid": user_id, "n": persona_name}).fetchone()

        if existing:
            # Persona already created by another agent with same name — reuse it
            persona_id = existing[0]
        else:
            # Create new persona from agent's identity fields
            conn.execute(sa.text(
                "INSERT INTO personas (user_id, name, system_prompt, voice_reference, avatar_uuid, "
                "character_config, preferred_name, trigger_word, created_at) "
                "VALUES (:uid, :name, :prompt, :voice, :avatar, CAST(:char_config AS json), :pref, :trigger, :created)"
            ), {
                "uid": user_id, "name": persona_name, "prompt": system_prompt or "",
                "voice": voice_ref, "avatar": avatar,
                "char_config": json.dumps(char_config) if char_config else None,
                "pref": pref_name, "trigger": trigger, "created": created,
            })
            persona_id = conn.execute(sa.text(
                "SELECT id FROM personas WHERE user_id = :uid AND name = :n"
            ), {"uid": user_id, "n": persona_name}).fetchone()[0]

        # Link agent to persona
        conn.execute(sa.text(
            "UPDATE agents SET persona_id = :pid WHERE id = :aid"
        ), {"pid": persona_id, "aid": agent_id})

        # Update character_config asset paths: /character-assets/{agent_id}/ → /character-assets/{persona_id}/
        if char_config and persona_id != agent_id:
            config_str = json.dumps(char_config)
            old_prefix = f"/character-assets/{agent_id}/"
            new_prefix = f"/character-assets/{persona_id}/"
            if old_prefix in config_str:
                config_str = config_str.replace(old_prefix, new_prefix)
                conn.execute(sa.text(
                    "UPDATE personas SET character_config = :config WHERE id = :pid"
                ), {"config": config_str, "pid": persona_id})

    # 4. Rename character asset directories on disk
    import os
    from pathlib import Path
    assets_dir = Path("data") / "character_assets"
    if assets_dir.exists():
        # Build agent_id → persona_id mapping
        mappings = conn.execute(sa.text(
            "SELECT id, persona_id FROM agents WHERE persona_id IS NOT NULL"
        )).fetchall()
        for agent_id, persona_id in mappings:
            if agent_id == persona_id:
                continue
            old_dir = assets_dir / str(agent_id)
            new_dir = assets_dir / str(persona_id)
            if old_dir.exists() and not new_dir.exists():
                old_dir.rename(new_dir)

    # 5. Add FK constraint and drop old columns
    op.create_foreign_key(
        'fk_agents_persona_id', 'agents', 'personas',
        ['persona_id'], ['id'], ondelete='SET NULL',
    )
    op.drop_column('agents', 'avatar_uuid')
    op.drop_column('agents', 'preferred_name')
    op.drop_column('agents', 'trigger_word')
    op.drop_column('agents', 'voice_reference')
    op.drop_column('agents', 'character_config')


def downgrade() -> None:
    """Reverse: move persona fields back to agents, drop personas table."""

    # Re-add identity columns to agents
    op.add_column('agents', sa.Column('character_config', postgresql.JSON(astext_type=sa.Text()), nullable=True))
    op.add_column('agents', sa.Column('voice_reference', sa.VARCHAR(), nullable=True))
    op.add_column('agents', sa.Column('trigger_word', sa.VARCHAR(), nullable=True))
    op.add_column('agents', sa.Column('preferred_name', sa.TEXT(), nullable=True))
    op.add_column('agents', sa.Column('avatar_uuid', sa.VARCHAR(), nullable=True))

    # Copy persona fields back to agents
    conn = op.get_bind()
    conn.execute(sa.text("""
        UPDATE agents SET
            voice_reference = p.voice_reference,
            avatar_uuid = p.avatar_uuid,
            character_config = p.character_config,
            preferred_name = p.preferred_name,
            trigger_word = p.trigger_word
        FROM personas p
        WHERE agents.persona_id = p.id
    """))

    # Drop FK and column
    op.drop_constraint('fk_agents_persona_id', 'agents', type_='foreignkey')
    op.drop_column('agents', 'persona_id')
    op.drop_table('personas')
