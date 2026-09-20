"""Which files a ``character_config`` still needs, and the sweep that removes the rest.

The sweep deletes every file under a persona's directory that the config does
not name. That makes the classification the dangerous step: a config the walker
misreads as "references nothing" empties the directory. So ``referenced_paths``
is fail-closed — it answers ``None`` for anything it cannot classify, and
``cleanup_persona_assets`` deletes nothing on ``None``. An *empty* set is a real
answer ("keep nothing") and comes from exactly two places: a caller clearing the
config on purpose, and a well-formed pose tree that happens to reference no
file. It never comes from a shape the walker did not recognise: a ``null`` or
list where a dict belongs, a string where a list belongs, is ``None``, not an
empty tree — ``[]`` and ``{}`` used to be coerced into "nothing referenced" and
the directory went with them.
"""

import logging
import shutil
from pathlib import Path
from typing import Optional

from kurisuassistant.character import paths

logger = logging.getLogger(__name__)

URL_PREFIX = "/character-assets/"

_PARTS = ("left_eye", "right_eye", "mouth")


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


def _list_or_none(container: dict, key: str) -> Optional[list]:
    """A list-valued member; missing or ``null`` is empty, anything else is unclassifiable."""
    value = container.get(key)
    if value is None:
        return []
    return value if isinstance(value, list) else None


def referenced_paths(persona_id: Optional[int], config) -> Optional[set[str]]:
    """Every asset a config references, as ``{persona_id}/{rel-without-suffix}``.

    ``None`` means the config could not be classified and nothing may be deleted
    on its account: a body that is not a pose-tree config, a pose tree whose
    shape is not the one the clients write (a dict of nodes and edges, each a
    dict, patches and video URLs in lists), or one whose URLs are not under
    ``/character-assets/{persona_id}/``. ``persona_id`` is ``None`` for a persona
    that does not exist yet (``POST /personas``), where any asset URL is foreign
    by definition. A URL outside ``/character-assets/`` is neither kept nor
    deleted: it is not ours.
    """
    if not isinstance(config, dict) or "pose_tree" not in config:
        return None
    pose_tree = config["pose_tree"]
    if not isinstance(pose_tree, dict):
        return None
    nodes = _list_or_none(pose_tree, "nodes")
    edges = _list_or_none(pose_tree, "edges")
    if nodes is None or edges is None:
        return None

    refs: set[str] = set()

    def _take(url) -> bool:
        if url is None or url == "":
            return True
        if not isinstance(url, str):
            return False
        if not url.startswith(URL_PREFIX):
            return True
        ref = _own_ref(url, persona_id)
        if ref is None:
            return False
        refs.add(ref)
        return True

    for node in nodes:
        if not isinstance(node, dict):
            return None
        pc = node.get("pose_config")
        if pc is None:
            continue
        if not isinstance(pc, dict):
            return None
        if not _take(pc.get("base_image_url")):
            return None
        for part_key in _PARTS:
            part = pc.get(part_key)
            if part is None:
                continue
            if not isinstance(part, dict):
                return None
            patches = _list_or_none(part, "patches")
            if patches is None:
                return None
            for patch in patches:
                if not isinstance(patch, dict):
                    return None
                if not _take(patch.get("image_url")):
                    return None
    for edge in edges:
        if not isinstance(edge, dict):
            return None
        transitions = _list_or_none(edge, "transitions")
        if transitions is None:
            return None
        for transition in transitions:
            if not isinstance(transition, dict):
                return None
            video_urls = _list_or_none(transition, "video_urls")
            if video_urls is None:
                return None
            for vurl in video_urls:
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
    files the old config still needs — and so it must never fail the response
    either: the row is committed, and a second save, an upload landing in a
    directory the walk just saw empty, or a file already gone are all things a
    later sweep will get right. Refuses to act on ``None``. Never enters
    ``.incoming/``: a streamed upload in progress has no reference yet. Never
    follows a symlink: the store writes none, so one is not its file to touch.
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
        if file_path.is_symlink() or incoming in file_path.parents:
            continue
        try:
            if not file_path.is_file():
                continue
            if file_to_ref_path(file_path, persona_id) not in referenced:
                file_path.unlink(missing_ok=True)
                logger.debug("Deleted orphaned character asset: %s", file_path)
        except OSError as error:
            logger.warning("persona %d: could not remove %s: %s", persona_id, file_path, error)

    for dir_path in sorted(persona_dir.rglob("*"), reverse=True):
        if dir_path.is_symlink() or dir_path == incoming or incoming in dir_path.parents:
            continue
        try:
            if dir_path.is_dir() and not any(dir_path.iterdir()):
                dir_path.rmdir()
                logger.debug("Removed empty directory: %s", dir_path)
        except OSError:
            # Gone already, or something arrived in it since the walk began —
            # either way the next sweep sees the truth.
            continue


def directory_bytes(directory: Path) -> int:
    """Bytes held by every file under ``directory`` (0 when it does not exist).

    Best effort: a file that vanishes between the listing and the ``stat``, or
    one the process may not read, counts as 0 rather than raising. The size is
    for a log line and a listing; nothing decides anything on it.
    """
    total = 0
    try:
        entries = list(directory.rglob("*"))
    except OSError:
        return 0
    for entry in entries:
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def remove_persona_assets(persona_id: int) -> int:
    """Remove everything a deleted persona owned; returns the bytes reclaimed.

    Called once the row is gone, so this must never raise: a disk failure here
    leaves stray files for the operator's sweep to find, never a live persona
    without its assets — and never a 500 for a delete that already happened.
    What could not be removed is measured afterwards and logged as a warning,
    because that log line is the only signal an operator has that the sweep
    is now needed.
    """
    persona_dir = paths.persona_dir(persona_id)
    before = directory_bytes(persona_dir)
    shutil.rmtree(persona_dir, ignore_errors=True)
    left = directory_bytes(persona_dir) if persona_dir.exists() else 0
    reclaimed = max(before - left, 0)
    if persona_dir.exists():
        logger.warning(
            "persona %d deleted but %d bytes were left behind under %s; "
            "run `python -m scripts.sweep_character_assets`",
            persona_id, left, persona_dir,
        )
    elif reclaimed:
        logger.info("persona %d deleted; reclaimed %d bytes of character assets", persona_id, reclaimed)
    return reclaimed
