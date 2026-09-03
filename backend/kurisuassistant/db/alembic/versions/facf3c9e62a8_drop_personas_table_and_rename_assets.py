"""drop_personas_table_and_rename_assets

Revision ID: facf3c9e62a8
Revises: 16a129919a0c
Create Date: 2026-04-19 23:51:20.590305

Finishes the persona→agent merge:
- Rebuilds the agent↔persona mapping by joining on (user_id, name)
  (agents.persona_id FK was dropped in 83e667457a0b).
- Renames ``data/character_assets/{persona_id}/`` → ``{agent_id}/`` on disk.
- Rewrites ``/character-assets/{persona_id}/...`` URLs in
  ``agents.character_config`` to use ``{agent_id}``.
- Drops the now-orphaned ``personas`` table.

Downgrade is intentionally lossy — the raw persona rows are not preserved
and the on-disk folders are not renamed back.
"""
import json
import logging
import os
from pathlib import Path
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'facf3c9e62a8'
down_revision: Union[str, Sequence[str], None] = '16a129919a0c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


logger = logging.getLogger("alembic.runtime.migration")

CHAR_ASSETS_DIR = Path(os.environ.get("DATA_DIR", "/app/data")) / "character_assets"


def _rewrite_config_urls(config: dict, old_id: int, new_id: int) -> dict:
    """Replace ``/character-assets/{old_id}/`` prefixes with ``/character-assets/{new_id}/``."""
    old_prefix = f"/character-assets/{old_id}/"
    new_prefix = f"/character-assets/{new_id}/"
    if not config or not isinstance(config, dict):
        return config
    pose_tree = config.get("pose_tree")
    if not isinstance(pose_tree, dict):
        return config
    for node in pose_tree.get("nodes", []) or []:
        pc = node.get("pose_config") or {}
        url = pc.get("base_image_url")
        if isinstance(url, str) and url.startswith(old_prefix):
            pc["base_image_url"] = new_prefix + url[len(old_prefix):]
        for part_key in ("left_eye", "right_eye", "mouth"):
            part = pc.get(part_key) or {}
            for patch in part.get("patches", []) or []:
                purl = patch.get("image_url")
                if isinstance(purl, str) and purl.startswith(old_prefix):
                    patch["image_url"] = new_prefix + purl[len(old_prefix):]
    for edge in pose_tree.get("edges", []) or []:
        for transition in edge.get("transitions", []) or []:
            video_urls = transition.get("video_urls") or []
            transition["video_urls"] = [
                (new_prefix + v[len(old_prefix):]) if isinstance(v, str) and v.startswith(old_prefix) else v
                for v in video_urls
            ]
    return config


def upgrade() -> None:
    """Upgrade schema."""
    conn = op.get_bind()

    # Recover agent_id ↔ persona_id mapping via (user_id, name) join.
    # The FK was dropped in 83e667457a0b, but the merge migration preserved
    # personas.name == agents.name within the same user scope.
    mapping_rows = conn.execute(sa.text("""
        SELECT a.id AS agent_id, p.id AS persona_id, a.character_config
        FROM agents a
        JOIN personas p ON p.user_id = a.user_id AND p.name = a.name
    """)).fetchall()

    for row in mapping_rows:
        agent_id = row.agent_id
        persona_id = row.persona_id
        config = row.character_config
        if persona_id == agent_id:
            # Same ID — nothing to rename
            continue

        # Rename on-disk asset directory
        old_dir = CHAR_ASSETS_DIR / str(persona_id)
        new_dir = CHAR_ASSETS_DIR / str(agent_id)
        if old_dir.exists() and old_dir.is_dir():
            if new_dir.exists():
                logger.warning(
                    "Asset dir collision: %s already exists, skipping rename from %s",
                    new_dir, old_dir,
                )
            else:
                old_dir.rename(new_dir)
                logger.info("Renamed character assets: %s → %s", old_dir, new_dir)

        # Rewrite URLs in character_config
        if config:
            cfg = config if isinstance(config, dict) else json.loads(config)
            new_cfg = _rewrite_config_urls(cfg, persona_id, agent_id)
            conn.execute(
                sa.text("UPDATE agents SET character_config = CAST(:cfg AS JSON) WHERE id = :aid"),
                {"cfg": json.dumps(new_cfg), "aid": agent_id},
            )

    # Drop the orphaned personas table
    op.drop_table('personas')


def downgrade() -> None:
    """Downgrade schema.

    Re-creates the ``personas`` table schema but does NOT restore data,
    and does NOT rename ``{agent_id}/`` folders back to ``{persona_id}/``
    or rewrite URLs. Only useful if rolling back on an empty database.
    """
    op.create_table(
        'personas',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('system_prompt', sa.Text(), nullable=True, server_default=''),
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
