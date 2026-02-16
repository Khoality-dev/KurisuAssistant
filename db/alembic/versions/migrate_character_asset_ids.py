"""Migrate character asset IDs from pose-* to 8-char hex

Renames node IDs, edge IDs, all URL references, default_pose_id(s),
and renames asset folders/files on disk.

Revision ID: migrate_character_asset_ids
Revises: a6282a65e5ad
Create Date: 2026-02-15
"""
import json
import logging
import os
import re
import shutil
from pathlib import Path

from alembic import op
import sqlalchemy as sa

logger = logging.getLogger(__name__)

revision = 'migrate_character_asset_ids'
down_revision = 'a6282a65e5ad'
branch_labels = None
depends_on = None

CHAR_ASSETS_DIR = Path(__file__).parent.parent.parent.parent / "data" / "character_assets"

OLD_ID_PATTERN = re.compile(r'^pose-')


def _random_hex_id() -> str:
    return os.urandom(4).hex()


def _remap_url(url: str, id_mapping: dict[str, str]) -> str:
    result = url
    for old_id, new_id in id_mapping.items():
        result = result.replace(old_id, new_id)
    return result


def _migrate_config(config: dict, agent_id: int) -> dict | None:
    """Migrate a character_config dict in-place. Returns id_mapping if changed, None otherwise."""
    pose_tree = config.get("pose_tree")
    if not pose_tree or not pose_tree.get("nodes"):
        return None

    nodes = pose_tree.get("nodes", [])
    edges = pose_tree.get("edges", [])

    # Check if migration is needed
    needs_migration = any(OLD_ID_PATTERN.match(n.get("id", "")) for n in nodes)
    if not needs_migration:
        # Still migrate default_pose_id → default_pose_ids if needed
        if "default_pose_id" in pose_tree and "default_pose_ids" not in pose_tree:
            old_default = pose_tree.pop("default_pose_id")
            pose_tree["default_pose_ids"] = [old_default] if old_default else [nodes[0]["id"]]
            return {}  # empty mapping = no file renames needed, but config changed
        if "default_pose_ids" not in pose_tree:
            pose_tree["default_pose_ids"] = [nodes[0]["id"]] if nodes else []
            return {}
        return None

    # Build old→new mapping
    id_mapping: dict[str, str] = {}
    for node in nodes:
        if OLD_ID_PATTERN.match(node["id"]):
            id_mapping[node["id"]] = _random_hex_id()

    # Remap nodes
    for node in nodes:
        old_id = node["id"]
        if old_id in id_mapping:
            node["id"] = id_mapping[old_id]

        # Remap image URLs in pose_config
        pc = node.get("pose_config")
        if pc:
            if pc.get("base_image_url"):
                pc["base_image_url"] = _remap_url(pc["base_image_url"], id_mapping)
            for part_key in ("left_eye", "right_eye", "mouth"):
                part = pc.get(part_key, {})
                for patch in part.get("patches", []):
                    if patch.get("image_url"):
                        patch["image_url"] = _remap_url(patch["image_url"], id_mapping)

    # Build edge ID mapping for video URL remapping
    edge_id_mapping: dict[str, str] = {}

    # Remap edges
    for edge in edges:
        old_edge_id = edge["id"]
        new_from = id_mapping.get(edge["from_node_id"], edge["from_node_id"])
        new_to = id_mapping.get(edge["to_node_id"], edge["to_node_id"])
        new_edge_id = f"{new_from}-{new_to}"
        edge_id_mapping[old_edge_id] = new_edge_id

        edge["id"] = new_edge_id
        edge["from_node_id"] = new_from
        edge["to_node_id"] = new_to

        for transition in edge.get("transitions", []):
            video_urls = transition.get("video_urls")
            if video_urls:
                transition["video_urls"] = [
                    _remap_url(_remap_url(url, id_mapping), edge_id_mapping)
                        .replace("/edges/edge-", "/edges/")
                    for url in video_urls
                ]

    # Migrate default_pose_id → default_pose_ids
    old_default = pose_tree.pop("default_pose_id", None)
    existing_defaults = pose_tree.get("default_pose_ids")
    if existing_defaults:
        pose_tree["default_pose_ids"] = [
            id_mapping.get(d, d) for d in existing_defaults
        ]
    elif old_default:
        pose_tree["default_pose_ids"] = [id_mapping.get(old_default, old_default)]
    else:
        pose_tree["default_pose_ids"] = [nodes[0]["id"]] if nodes else []

    return id_mapping


def _rename_files(agent_id: int, id_mapping: dict[str, str]) -> None:
    """Rename pose folders and edge video files on disk."""
    agent_dir = CHAR_ASSETS_DIR / str(agent_id)
    if not agent_dir.exists():
        return

    # Rename pose folders
    for old_id, new_id in id_mapping.items():
        old_dir = agent_dir / old_id
        new_dir = agent_dir / new_id
        if old_dir.exists() and old_dir.is_dir():
            if new_dir.exists():
                for f in old_dir.iterdir():
                    shutil.move(str(f), str(new_dir / f.name))
                old_dir.rmdir()
            else:
                old_dir.rename(new_dir)
            logger.info("Migrated pose folder: %s/%s → %s", agent_id, old_id, new_id)

    # Rename edge video files
    edges_dir = agent_dir / "edges"
    if edges_dir.exists():
        for video_file in list(edges_dir.iterdir()):
            if not video_file.is_file():
                continue
            old_name = video_file.stem
            new_name = old_name
            for old_id, new_id in id_mapping.items():
                new_name = new_name.replace(old_id, new_id)
            if new_name.startswith("edge-"):
                new_name = new_name[5:]
            if new_name != old_name:
                new_path = video_file.with_name(new_name + video_file.suffix)
                video_file.rename(new_path)
                logger.info("Migrated edge video: %s → %s", video_file.name, new_path.name)


def upgrade() -> None:
    """Migrate old pose-* node IDs to 8-char hex in all character_config JSON."""
    conn = op.get_bind()
    results = conn.execute(
        sa.text("SELECT id, character_config FROM agents WHERE character_config IS NOT NULL")
    ).fetchall()

    for agent_id, config in results:
        if not config:
            continue

        id_mapping = _migrate_config(config, agent_id)
        if id_mapping is None:
            continue

        # Update DB
        conn.execute(
            sa.text("UPDATE agents SET character_config = :config WHERE id = :id"),
            {"config": json.dumps(config), "id": agent_id},
        )
        logger.info("Migrated character config for agent %s (remapped %d node IDs)", agent_id, len(id_mapping))

        # Rename files on disk
        if id_mapping:
            _rename_files(agent_id, id_mapping)


def downgrade() -> None:
    """No automatic downgrade — old IDs are not recoverable."""
    pass
