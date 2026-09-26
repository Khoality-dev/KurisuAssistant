"""A persona's character as a portable bundle, and the import that restores it (#248).

A v3 export is JSON with no media, because every file a persona's character
names exists only on the server that exported it. A **v4 bundle** carries them:
a zip holding ``persona.json`` — the v3 fields, plus ``character`` — and the
files under ``character/``, at the paths the store keeps them at
(``p1/base.png``, ``edges/e1.mp4``, ``vrm/{sha256}.vrm``, ``vrma/{clip_id}.vrma``).

``character`` is ``{config, files}`` or ``null``. ``config`` is the stored
``character_config`` with every ``/character-assets/{id}/`` written as
``/character-assets/{persona_id}/`` — a literal placeholder, since the persona
it will belong to does not exist yet. ``files`` lists each file with its size
and sha256. Only the files the config still references travel; a file nothing
names stays behind, as the next save's sweep would have removed it anyway. A
file the config names that is not on disk fails the export (a 500 and an error
in the log): the store contradicting itself is a fault to surface, and a bundle
that quietly left the model out would restore a persona with no character.

An import is untrusted input from another install, so it re-derives what the
upload routes would have and trusts nothing it can check:

* every listed path must be one the store itself writes, and within the ceiling
  for its kind; each file is read from the zip bounded by its listed size and
  must hash to its listed digest (a zip's own sizes are the sender's claim too);
* the model and clips are inspected like an upload, and their refs are rebuilt
  here from the bytes — sha, size, spec version, faces — not read from the file;
* the config is planned through ``config_write`` with those refs as the stored
  ones, so the same schema, the same clip-id check and the same ownership rule
  apply: a URL left pointing at any persona but the new one is a 422;
* the model and clips count against the account's quota, measured in the
  transaction that creates the persona. Pose art is not metered, as ever.

The bundle streams to the store's own ``.incoming/`` (the same bounded write
the uploads use), is checked there and extracted beside it, and only after the
persona row is committed are its files moved into the new persona's directory,
under that persona's lock. Nothing is left in ``.incoming`` on any outcome but
a killed process, and the next import sweeps what that leaves.

Blocking functions here are called in a worker thread by the router.
"""

import hashlib
import json
import logging
import os
import re
import tempfile
import zipfile
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from kurisuassistant.character import assets, paths
from kurisuassistant.character.references import URL_PREFIX, classify, file_to_ref_path

logger = logging.getLogger(__name__)

#: The bundle format. The JSON-only export stays version 3.
BUNDLE_VERSION = 4

# A bundle has no size ceiling of its own (the owner's call, #248): what it may
# hold is bounded by each file's own ceiling and the account's quota, as the
# uploads are.

#: Most files one bundle may list — a guard against a zip whose directory alone
#: would exhaust memory, not a size limit. A pose graph is a base image and a
#: few patches per pose plus a video per edge; thousands is far past any real one.
BUNDLE_MAX_FILES = int(os.getenv("PERSONA_BUNDLE_MAX_FILES", "4096"))

#: Largest ``persona.json``. A pose tree with hundreds of nodes is well under.
MANIFEST_MAX_BYTES = 4 * assets.MIB

PLACEHOLDER = "/character-assets/{persona_id}/"
MANIFEST_NAME = "persona.json"
FILES_PREFIX = "character/"
MEDIA_TYPE = "application/zip"

_CHUNK = 1024 * 1024

#: What reading a damaged, encrypted or oddly compressed entry can raise.
_UNREADABLE = (zipfile.BadZipFile, zlib.error, NotImplementedError, RuntimeError, EOFError)
_SHA256 = re.compile(r"[0-9a-f]{64}")
_CLIP_ID = re.compile(r"[0-9a-f]{8}")

_MODEL = re.compile(r"vrm/(?P<sha>[0-9a-f]{64})\.vrm")
_CLIP = re.compile(r"vrma/(?P<id>[0-9a-f]{8})\.vrma")
_EDGE = re.compile(r"edges/(?P<stem>[^/\\]+)\.(?P<ext>mp4|webm)")
_POSE = re.compile(r"(?P<pose>[^/\\]+)/(?P<stem>[^/\\]+)\.(?P<ext>png|jpg)")


def bad_bundle(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)


# ── export ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CharacterFiles:
    """What a persona's character is made of on disk: ``(path in the bundle, file)`` pairs."""

    kind: str
    files: list[tuple[str, Path]]

    @property
    def bytes(self) -> int:
        return sum(_size(path) for _, path in self.files)

    @property
    def vrm_bytes(self) -> int:
        return sum(_size(path) for name, path in self.files if name.startswith(("vrm/", "vrma/")))


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def character_files(persona_id: int, config) -> Optional[CharacterFiles]:
    """The files a persona's character references; ``None`` when it has no character.

    Blocking. A stored config the walker cannot classify cannot be exported —
    there is no telling which files it needs — and is a 409 rather than a
    bundle that silently lacks them. A file it references that is not on disk
    is a 500 (``files_missing``).
    """
    if not isinstance(config, dict):
        return None
    classification = classify(persona_id, config)
    if classification.refs is None:
        raise assets.refusal(
            409, "unreadable_character",
            "This persona's character could not be read, so it cannot be exported with it.",
        )
    persona_dir = paths.persona_dir(persona_id)
    incoming = persona_dir / paths.INCOMING_DIR_NAME
    found: list[tuple[str, Path]] = []
    if persona_dir.exists():
        for file_path in sorted(persona_dir.rglob("*")):
            if file_path.is_symlink() or incoming in file_path.parents or not file_path.is_file():
                continue
            if file_to_ref_path(file_path, persona_id) in classification.refs:
                found.append((file_path.relative_to(persona_dir).as_posix(), file_path))
    missing = classification.refs - {file_to_ref_path(path, persona_id) for _, path in found}
    if missing:
        raise files_missing(persona_id, sorted(missing))
    return CharacterFiles(kind=config.get("kind"), files=found)


def files_missing(persona_id: int, missing: list[str]):
    """The store contradicting itself: logged as the fault it is, and a 500 that says so."""
    logger.error("persona %d: character config references files missing on disk: %s",
                 persona_id, ", ".join(missing))
    return assets.refusal(
        500, "character_files_missing",
        "Some of this persona's character files are missing on the server, so it cannot be exported.",
    )


def _rewrite(value: Any, old: str, new: str) -> Any:
    """``value`` with every string that starts with ``old`` starting with ``new`` instead."""
    if isinstance(value, dict):
        return {key: _rewrite(item, old, new) for key, item in value.items()}
    if isinstance(value, list):
        return [_rewrite(item, old, new) for item in value]
    if isinstance(value, str) and value.startswith(old):
        return new + value[len(old):]
    return value


def portable_config(persona_id: int, config: dict) -> dict:
    """The config as a bundle carries it: its own URLs against the placeholder.

    Every file it names is in the bundle — ``character_files`` refuses one
    whose file is missing — so nothing is dropped here.
    """
    return _rewrite(config, f"{URL_PREFIX}{persona_id}/", PLACEHOLDER)


def write_bundle(meta: dict, persona_id: int, config, character: Optional[CharacterFiles]) -> Path:
    """Write the bundle to a temporary file and return its path; the caller removes it.

    Blocking. Stored, not deflated: the model is already a binary, the art is
    PNG and the videos are compressed, and deflating 100 MB would cost seconds
    for nothing. Each file is hashed as it is copied, so the listed digest is
    of the bytes that went into the zip.
    """
    handle, name = tempfile.mkstemp(prefix="kurisu-export-", suffix=".zip")
    os.close(handle)
    out = Path(name)
    try:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
            listed: list[dict] = []
            for bundle_path, file_path in (character.files if character else []):
                digest = hashlib.sha256()
                size = 0
                try:
                    source = open(file_path, "rb")
                except FileNotFoundError:
                    # Listed a moment ago under the persona's lock: gone now is
                    # the same fault as missing then.
                    raise files_missing(persona_id, [bundle_path])
                with source, archive.open(FILES_PREFIX + bundle_path, "w", force_zip64=True) as target:
                    while chunk := source.read(_CHUNK):
                        digest.update(chunk)
                        size += len(chunk)
                        target.write(chunk)
                listed.append({"path": bundle_path, "bytes": size, "sha256": digest.hexdigest()})
            meta = dict(meta)
            meta["version"] = BUNDLE_VERSION
            meta["character"] = None if character is None else {
                "config": portable_config(persona_id, config),
                "files": listed,
            }
            archive.writestr(MANIFEST_NAME, json.dumps(meta, ensure_ascii=False, indent=2),
                             compress_type=zipfile.ZIP_DEFLATED)
        return out
    except BaseException:
        out.unlink(missing_ok=True)
        raise


# ── import ───────────────────────────────────────────────────────────────────


@dataclass
class StagedCharacter:
    """A checked bundle's character: the config to plan and the files ready to place."""

    config: dict
    stored: dict
    staged: dict[str, Path]  # bundle path → extracted file in ``.incoming``
    digests: dict[str, str]  # bundle path → the sha256 its bytes were checked against


def incoming_dir() -> Path:
    """The store's own staging area for bundles, beside the persona directories."""
    return paths.CHAR_ASSETS_DIR / paths.INCOMING_DIR_NAME


def _ceiling(bundle_path: str) -> int:
    """The largest a file at this path may be; 400 for a path the store never writes."""
    if _MODEL.fullmatch(bundle_path):
        return assets.MODEL_MAX_BYTES
    if _CLIP.fullmatch(bundle_path):
        return assets.CLIP_MAX_BYTES
    edge = _EDGE.fullmatch(bundle_path)
    if edge:
        _plain(edge["stem"], bundle_path)
        return assets.VIDEO_MAX_BYTES
    pose = _POSE.fullmatch(bundle_path)
    if pose:
        _plain(pose["pose"], bundle_path)
        _plain(pose["stem"], bundle_path)
        return assets.IMAGE_MAX_BYTES
    raise bad_bundle(f"The bundle lists a file the store never writes: {bundle_path[:200]!r}.")


def _plain(segment: str, bundle_path: str) -> None:
    try:
        paths.safe_segment(segment, "path")
    except HTTPException:
        raise bad_bundle(f"The bundle lists a file the store never writes: {bundle_path[:200]!r}.")


def _what(bundle_path: str) -> str:
    if bundle_path.startswith("vrm/"):
        return "model"
    if bundle_path.startswith("vrma/"):
        return "animation"
    if bundle_path.startswith("edges/"):
        return "video"
    return "image"


#: The end-of-central-directory record, and the most a zip comment can push it back.
_EOCD = b"PK\x05\x06"
_EOCD_SEARCH = 22 + 0xFFFF

#: Largest central directory read: a bundle's few thousand entries, with names
#: the store writes, are a fraction of this.
DIRECTORY_MAX_BYTES = 16 * assets.MIB


def _check_directory(bundle_file: Path) -> None:
    """Refuse a zip whose central directory is bigger than any bundle's, before it is parsed.

    ``zipfile.ZipFile`` reads the whole directory as it opens, one object per
    entry — a 512 MiB body of empty entries would be millions of them before
    any other check ran. The end record says how many there are and how big
    the directory is; a bundle lists at most ``BUNDLE_MAX_FILES`` files plus
    ``persona.json``. A zip64 count (``0xFFFF``) is past that by definition.
    """
    size = bundle_file.stat().st_size
    with open(bundle_file, "rb") as handle:
        handle.seek(max(0, size - _EOCD_SEARCH))
        tail = handle.read()
    at = tail.rfind(_EOCD)
    if at < 0 or len(tail) - at < 22:
        raise bad_bundle("That file is not a persona bundle (.zip).")
    entries = int.from_bytes(tail[at + 10:at + 12], "little")
    directory = int.from_bytes(tail[at + 12:at + 16], "little")
    if entries > BUNDLE_MAX_FILES + 1 or directory > DIRECTORY_MAX_BYTES:
        raise bad_bundle(f"The bundle holds more than {BUNDLE_MAX_FILES} files.")


def open_bundle(bundle_file: Path) -> tuple[zipfile.ZipFile, dict]:
    """Open a streamed-in bundle and read its ``persona.json``. Blocking.

    400 for anything that is not a zip holding a JSON object there, or one
    whose directory is bigger than a bundle's could be.
    """
    _check_directory(bundle_file)
    try:
        archive = zipfile.ZipFile(bundle_file)
    except (zipfile.BadZipFile, OSError):
        raise bad_bundle("That file is not a persona bundle (.zip).")
    try:
        info = archive.getinfo(MANIFEST_NAME)
    except KeyError:
        archive.close()
        raise bad_bundle("That .zip is not a persona bundle: it has no persona.json.")
    try:
        raw = _read_bounded(archive, info, MANIFEST_MAX_BYTES)
        meta = json.loads(raw.decode("utf-8"))
    except (RecursionError, ValueError, UnicodeDecodeError, *_UNREADABLE):
        archive.close()
        raise bad_bundle("The bundle's persona.json could not be read.")
    except HTTPException:
        archive.close()
        raise
    if not isinstance(meta, dict):
        archive.close()
        raise bad_bundle("The bundle's persona.json must contain a JSON object.")
    return archive, meta


def _read_bounded(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes:
    """An entry's bytes, refusing more than ``limit`` whatever the zip claims."""
    with archive.open(info) as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise bad_bundle("The bundle's persona.json is too large.")
    return data


def stage_character(archive: zipfile.ZipFile, character, staging: Path) -> Optional[StagedCharacter]:
    """Check a bundle's character and extract its files into ``staging``. Blocking.

    Returns ``None`` for a bundle with no character. Raises 400 for a manifest
    or file that does not hold up, 413 for a file over its kind's ceiling, and
    the upload routes' 415s for a model or clip that is not one.
    """
    if character is None:
        return None
    if not isinstance(character, dict):
        raise bad_bundle("The bundle's character must be an object or null.")
    config = character.get("config")
    listed = character.get("files")
    if not isinstance(config, dict):
        raise bad_bundle("The bundle's character has no config.")
    if not isinstance(listed, list):
        raise bad_bundle("The bundle's character has no list of files.")
    if len(listed) > BUNDLE_MAX_FILES:
        raise bad_bundle(f"The bundle lists more than {BUNDLE_MAX_FILES} files.")

    entries: dict[str, dict] = {}
    for entry in listed:
        if not isinstance(entry, dict):
            raise bad_bundle("The bundle's list of files is not the shape an export writes.")
        bundle_path, size, digest = entry.get("path"), entry.get("bytes"), entry.get("sha256")
        if not isinstance(bundle_path, str) or not isinstance(size, int) or size < 0 \
                or not isinstance(digest, str) or not _SHA256.fullmatch(digest):
            raise bad_bundle("The bundle's list of files is not the shape an export writes.")
        ceiling = _ceiling(bundle_path)
        if size > ceiling:
            raise assets.too_large(ceiling, _what(bundle_path))
        if bundle_path in entries:
            raise bad_bundle(f"The bundle lists {bundle_path[:200]!r} twice.")
        model = _MODEL.fullmatch(bundle_path)
        if model and model["sha"] != digest:
            # The store names a model by its digest; a name that is not the
            # digest of the bytes would serve an ETag the bytes do not match.
            raise bad_bundle(f"{bundle_path[:200]!r} is not the file the bundle lists.")
        entries[bundle_path] = entry

    staged: dict[str, Path] = {}
    for index, (bundle_path, entry) in enumerate(entries.items()):
        try:
            info = archive.getinfo(FILES_PREFIX + bundle_path)
        except KeyError:
            raise bad_bundle(f"The bundle lists {bundle_path[:200]!r} but does not hold it.")
        target = staging.with_name(f"{staging.name}-{index}")
        _extract(archive, info, entry["bytes"], entry["sha256"], target, bundle_path)
        staged[bundle_path] = target

    digests = {bundle_path: entry["sha256"] for bundle_path, entry in entries.items()}
    return StagedCharacter(config=config, stored=_rebuild_refs(config, staged, digests),
                           staged=staged, digests=digests)


def _extract(archive, info, size: int, digest: str, target: Path, bundle_path: str) -> None:
    """Copy one entry out, stopping at ``size`` bytes; 400 unless it is exactly the listed file."""
    sha = hashlib.sha256()
    written = 0
    try:
        with archive.open(info) as source, open(target, "wb") as out:
            while chunk := source.read(min(_CHUNK, size + 1 - written)):
                written += len(chunk)
                if written > size:
                    break
                sha.update(chunk)
                out.write(chunk)
    except _UNREADABLE:
        raise bad_bundle(f"{bundle_path[:200]!r} is damaged in the bundle.")
    if written != size or sha.hexdigest() != digest:
        raise bad_bundle(f"{bundle_path[:200]!r} is not the file the bundle lists.")


def _rebuild_refs(config: dict, staged: dict[str, Path], digests: dict[str, str]) -> dict:
    """The server-owned ``vrm.model``/``vrm.clips`` for the new persona, from the files themselves.

    Placeholder URLs; ``place`` resolves them with the rest of the config. Only
    what the bundle's config names is rebuilt, and each must have its file.
    The display fields a user chose — the model's filename, a clip's name and
    loop — are kept, cut as an upload would cut them.
    """
    vrm = config.get("vrm")
    if not isinstance(vrm, dict):
        return {}
    model_ref = None
    model = vrm.get("model")
    if model is not None:
        if not isinstance(model, dict):
            raise bad_bundle("The bundle's model is not the shape an export writes.")
        bundle_path = f"vrm/{model.get('sha256')}.vrm"
        file = staged.get(bundle_path)
        if file is None:
            raise bad_bundle("The bundle's config names a model the bundle does not hold.")
        info = assets.inspect_model_file(file)
        uploaded = model.get("uploaded_at")
        model_ref = {
            "url": f"{PLACEHOLDER}vrm/model",
            "sha256": digests[bundle_path],
            "bytes": file.stat().st_size,
            "uploaded_at": uploaded if isinstance(uploaded, str) and len(uploaded) <= 64 else _now(),
            "filename": assets.display_filename(model.get("filename"), "model.vrm"),
            "spec_version": info.spec_version,
            "expressions": info.expressions,
        }
    clip_refs = []
    clips = vrm.get("clips") or []
    if not isinstance(clips, list):
        raise bad_bundle("The bundle's clips are not the shape an export writes.")
    for clip in clips:
        clip_id = clip.get("id") if isinstance(clip, dict) else None
        if not isinstance(clip_id, str) or not _CLIP_ID.fullmatch(clip_id):
            raise bad_bundle("The bundle's clips are not the shape an export writes.")
        bundle_path = f"vrma/{clip_id}.vrma"
        file = staged.get(bundle_path)
        if file is None:
            raise bad_bundle("The bundle's config names an animation the bundle does not hold.")
        assets.inspect_clip_file(file)
        clip_refs.append({
            "id": clip_id,
            "name": assets.display_filename(clip.get("name"), "animation"),
            "url": f"{PLACEHOLDER}vrma/{clip_id}",
            "sha256": digests[bundle_path],
            "bytes": file.stat().st_size,
            "loop": bool(clip.get("loop", False)),
        })
    return {"vrm": {"model": model_ref, "clips": clip_refs}}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def for_persona(value: Any, persona_id: int) -> Any:
    """A bundle's placeholder URLs resolved to one persona's own."""
    return _rewrite(value, PLACEHOLDER, f"{URL_PREFIX}{persona_id}/")


def place(persona_id: int, staged: dict[str, Path], referenced: set[str]) -> None:
    """Move the extracted files the committed config references into the persona's directory.

    Blocking; called under the persona's lock once the row is committed. A file
    the config does not reference is left for the caller to discard.
    """
    persona_dir = paths.persona_dir(persona_id)
    for bundle_path, file in staged.items():
        if f"{persona_id}/{Path(bundle_path).with_suffix('').as_posix()}" not in referenced:
            continue
        final = persona_dir / bundle_path
        final.parent.mkdir(parents=True, exist_ok=True)
        os.replace(file, final)
