"""Which files a ``character_config`` still needs, and the sweep that removes the rest.

The sweep deletes every file under a persona's directory that the config does
not name. That makes the classification the dangerous step: a config the walker
misreads as "references nothing" empties the directory. So ``referenced_paths``
is fail-closed — it answers ``None`` for anything it cannot classify, and
``cleanup_persona_assets`` deletes nothing on ``None``. An *empty* set is a real
answer ("keep nothing") and comes from exactly two places: a caller clearing the
config on purpose, and a well-formed config that happens to reference no
file. It never comes from a shape the walker did not recognise: a ``null`` or
list where a dict belongs, a string where a list belongs, is ``None``, not an
empty tree — ``[]`` and ``{}`` used to be coerced into "nothing referenced" and
the directory went with them.
"""

import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from kurisuassistant.character import paths
from kurisuassistant.character.schema import KINDS

logger = logging.getLogger(__name__)

URL_PREFIX = "/character-assets/"

_PARTS = ("left_eye", "right_eye", "mouth")

_SHA256 = re.compile(r"[0-9a-f]{64}")

# The two reasons a member is refused, worded to finish the sentence
# "character_config.<member> …" in a 422 detail. A client that sent a member of
# the wrong shape and one that pointed at another persona's art need to be told
# different things, and the desktop shows the detail verbatim.
SHAPE = "is not the shape the clients write"
FOREIGN = "names another persona's assets"

# What ``take`` answers: ``None`` when the URL is fine, else why it is not.
_Take = Callable[[object], Optional[str]]


@dataclass(frozen=True)
class Classification:
    """What a config references — or, when ``refs`` is ``None``, why it could not be read."""

    refs: Optional[set[str]]
    refusal: Optional[str]


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


def classify(persona_id: Optional[int], config) -> Classification:
    """Every asset a config references, as ``{persona_id}/{rel-without-suffix}`` — or why not.

    Both members are walked whatever ``kind`` says: a persona keeps its pose art
    while it shows a VRM model and vice versa, so the files the other system
    needs are references too. ``None`` means the config could not be classified
    and nothing may be deleted on its account: no recognised ``kind``; a member
    whose shape is not the one the clients write (a pose tree is a dict of nodes
    and edges, each a dict, with patches and video URLs in lists; a VRM member
    is a dict whose ``model`` is null or a dict with a string ``url`` and whose
    ``clips`` are dicts with string ``url``s); or a URL not under
    ``/character-assets/{persona_id}/``. A member that is missing or ``null``
    references nothing. ``persona_id`` is ``None`` for a persona that does not
    exist yet (``POST /personas``), where any asset URL is foreign by definition.
    A URL outside ``/character-assets/`` is neither kept nor deleted: it is not
    ours.

    A refusal names the member and the cause — ``SHAPE`` or ``FOREIGN`` — so the
    write path can tell the client which of the two it got wrong, and whether it
    was the body or a member the store already held.
    """
    if not isinstance(config, dict):
        return Classification(None, "character_config must be an object.")
    if config.get("kind") not in KINDS:
        return Classification(None, 'character_config.kind must be "pose_graph" or "vrm".')

    refs: set[str] = set()

    def _take(url, stored_as: Optional[str] = None) -> Optional[str]:
        """Check a URL is this persona's and keep the file it names.

        ``stored_as`` is for an asset whose file is not named by its URL: the
        VRM model is served at ``…/vrm/model`` but stored content-addressed as
        ``vrm/{sha256}.vrm`` (#236), so the file to keep comes from its ref.
        """
        if url is None or url == "":
            return None
        if not isinstance(url, str):
            return SHAPE
        if not url.startswith(URL_PREFIX):
            return None
        ref = _own_ref(url, persona_id)
        if ref is None:
            return FOREIGN
        refs.add(f"{persona_id}/{stored_as}" if stored_as else ref)
        return None

    for member, walk in (("pose_tree", _walk_pose_tree), ("vrm", _walk_vrm)):
        value = config.get(member)
        if value is None:
            continue
        why = SHAPE if not isinstance(value, dict) else walk(value, _take)
        if why is not None:
            return Classification(None, f"character_config.{member} {why}.")
    return Classification(refs, None)


def referenced_paths(persona_id: Optional[int], config) -> Optional[set[str]]:
    """``classify`` without the reason: the set, or ``None`` when nothing may be deleted."""
    return classify(persona_id, config).refs


def _walk_pose_tree(pose_tree: dict, take: _Take) -> Optional[str]:
    """Feed every pose-tree URL to ``take``; the reason when the shape or a URL is not ours."""
    nodes = _list_or_none(pose_tree, "nodes")
    edges = _list_or_none(pose_tree, "edges")
    if nodes is None or edges is None:
        return SHAPE
    for node in nodes:
        if not isinstance(node, dict):
            return SHAPE
        pc = node.get("pose_config")
        if pc is None:
            continue
        if not isinstance(pc, dict):
            return SHAPE
        why = take(pc.get("base_image_url"))
        if why is not None:
            return why
        for part_key in _PARTS:
            part = pc.get(part_key)
            if part is None:
                continue
            if not isinstance(part, dict):
                return SHAPE
            patches = _list_or_none(part, "patches")
            if patches is None:
                return SHAPE
            for patch in patches:
                if not isinstance(patch, dict):
                    return SHAPE
                why = take(patch.get("image_url"))
                if why is not None:
                    return why
    for edge in edges:
        if not isinstance(edge, dict):
            return SHAPE
        transitions = _list_or_none(edge, "transitions")
        if transitions is None:
            return SHAPE
        for transition in transitions:
            if not isinstance(transition, dict):
                return SHAPE
            video_urls = _list_or_none(transition, "video_urls")
            if video_urls is None:
                return SHAPE
            for vurl in video_urls:
                why = take(vurl)
                if why is not None:
                    return why
    return None


def _walk_vrm(vrm: dict, take) -> Optional[str]:
    """Feed the model and clip URLs to ``take``; the reason when the shape or a URL is not ours.

    The model's file is ``vrm/{sha256}.vrm`` — content-addressed, so a replaced
    model is a new file and the old one is swept — which makes a model ref
    without a well-formed ``sha256`` unplaceable.
    """
    model = vrm.get("model")
    if model is not None:
        if not isinstance(model, dict) or not isinstance(model.get("url"), str):
            return SHAPE
        sha = model.get("sha256")
        if not isinstance(sha, str) or not _SHA256.fullmatch(sha):
            # The URL is checked first so a foreign model still reads as foreign.
            return take(model["url"]) or SHAPE
        why = take(model["url"], f"vrm/{sha}")
        if why is not None:
            return why
    clips = _list_or_none(vrm, "clips")
    if clips is None:
        return SHAPE
    for clip in clips:
        if not isinstance(clip, dict) or not isinstance(clip.get("url"), str):
            return SHAPE
        why = take(clip["url"])
        if why is not None:
            return why
    return None


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
