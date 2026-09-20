"""Which files a ``character_config`` still needs, and the sweep that removes the rest.

The sweep deletes every file under a persona's directory that the config does
not name. That makes the classification the dangerous step: a config the walker
misreads as "references nothing" empties the directory. So ``referenced_paths``
is fail-closed — it answers ``None`` for anything it cannot classify, and
``cleanup_persona_assets`` deletes nothing on ``None``. An *empty* set is a real
answer ("keep nothing") and is only ever produced on purpose, by a caller
clearing the config.
"""

import logging
from pathlib import Path
from typing import Optional

from kurisuassistant.character import paths

logger = logging.getLogger(__name__)

URL_PREFIX = "/character-assets/"


def _own_ref(url: str, persona_id: Optional[int]) -> Optional[str]:
    """The reference path of a URL, or ``None`` if it is not this persona's.

    A pose tree pointing at another persona — an imported config, or one copied
    between installs — used to yield a set that matched none of this persona's
    files, and the sweep removed them all. A foreign prefix is therefore not
    "no reference", it is "cannot classify".
    """
    if not url.startswith(URL_PREFIX):
        return None
    ref = url[len(URL_PREFIX):]
    if persona_id is None or not ref.startswith(f"{persona_id}/"):
        return None
    return ref


def referenced_paths(persona_id: Optional[int], config) -> Optional[set[str]]:
    """Every asset a config references, as ``{persona_id}/{rel-without-suffix}``.

    ``None`` means the config could not be classified and nothing may be deleted
    on its account: a body that is not a pose-tree config, or one whose URLs are
    not under ``/character-assets/{persona_id}/``. ``persona_id`` is ``None`` for
    a persona that does not exist yet (``POST /personas``), where any asset URL
    is foreign by definition.
    """
    if not isinstance(config, dict) or "pose_tree" not in config:
        return None
    pose_tree = config.get("pose_tree") or {}
    if not isinstance(pose_tree, dict):
        return None

    refs: set[str] = set()

    def _take(url) -> bool:
        if not isinstance(url, str) or not url:
            return True
        if not url.startswith(URL_PREFIX):
            return True  # an external URL is not ours to keep or delete
        ref = _own_ref(url, persona_id)
        if ref is None:
            return False
        refs.add(ref)
        return True

    for node in pose_tree.get("nodes") or []:
        pc = node.get("pose_config") if isinstance(node, dict) else None
        if not pc:
            continue
        if not _take(pc.get("base_image_url", "")):
            return None
        for part_key in ("left_eye", "right_eye", "mouth"):
            for patch in (pc.get(part_key) or {}).get("patches") or []:
                if not _take(patch.get("image_url", "")):
                    return None
    for edge in pose_tree.get("edges") or []:
        for transition in (edge.get("transitions") or []) if isinstance(edge, dict) else []:
            for vurl in transition.get("video_urls") or []:
                if not _take(vurl):
                    return None
    return refs


def file_to_ref_path(file_path: Path, persona_id: int) -> str:
    """Disk file → reference path (relative, no extension, POSIX separators).

    ``data/character_assets/1/a1b2/base.png`` → ``"1/a1b2/base"``.
    """
    rel = file_path.relative_to(paths.persona_dir(persona_id)).with_suffix("")
    return f"{persona_id}/{rel.as_posix()}"


def cleanup_persona_assets(persona_id: int, referenced: Optional[set[str]]) -> None:
    """Remove every file the config no longer names, then the directories left empty.

    Runs *after* the config has been written — a failed save must not cost the
    files the old config still needs. Refuses to act on ``None``. Never enters
    ``.incoming/``: a streamed upload in progress has no reference yet.
    """
    if referenced is None:
        logger.warning(
            "persona %d: character config could not be classified; no assets removed",
            persona_id,
        )
        return
    persona_dir = paths.persona_dir(persona_id)
    if not persona_dir.exists():
        return

    incoming = persona_dir / paths.INCOMING_DIR_NAME
    for file_path in persona_dir.rglob("*"):
        if not file_path.is_file() or incoming in file_path.parents:
            continue
        if file_to_ref_path(file_path, persona_id) not in referenced:
            file_path.unlink()
            logger.debug("Deleted orphaned character asset: %s", file_path)

    for dir_path in sorted(persona_dir.rglob("*"), reverse=True):
        if dir_path == incoming or incoming in dir_path.parents:
            continue
        if dir_path.is_dir() and not any(dir_path.iterdir()):
            dir_path.rmdir()
            logger.debug("Removed empty directory: %s", dir_path)
