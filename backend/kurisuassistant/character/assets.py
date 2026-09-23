"""The VRM half of the character store: limits, validation, and what an account uses.

A persona's VRM model lives at ``{persona_id}/vrm/model.vrm`` and each of its
clips at ``{persona_id}/vrma/{clip_id}.vrma``, beside the pose art — not in Kurisu
Drive, whose rows no persona points at and whose files the assistant's own
``drive_delete`` can remove (``docs/drive.md``). The refs to those files live in
``personas.character_config`` and are **server-owned**: only the routes in
``routers/character.py`` write ``vrm.model`` and ``vrm.clips``, inside the
transaction that accepts the bytes, and ``config_write`` puts the stored values
back over whatever a config body says.

That makes the stored refs the one source of truth for three things: what the
cleanup walker keeps, what the ETag is (the sha256 recorded at upload, never
re-hashed per request), and how much of the quota an account has used — the sum
of the refs' ``bytes``, read on the database thread inside the same transaction
that records a new one, which is what makes two concurrent uploads unable to
overshoot it (the drive's mechanism, ``routers/drive.py``).

Validation reads only the glTF header and the JSON chunk, bounded before
anything is parsed: a chunk length is an attacker-chosen uint32, and a deep or
huge JSON document parsed on the event loop would stall every connected user.
It is parsed in a worker thread; ``RecursionError``, ``ValueError`` and
``UnicodeDecodeError`` are all a 415.

Every refusal is ``{code, message}``: the desktop shows its own wording for a
code it knows and the message for one it does not.
"""

import json
import os
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

MIB = 1024 * 1024

#: Largest VRM model. A VRoid Studio export with 2048² textures is typically
#: 15–40 MB; "high" texture settings and unmerged materials reach 60–100 MB.
MODEL_MAX_BYTES = int(os.getenv("CHARACTER_MODEL_MAX_BYTES", str(100 * MIB)))

#: Largest VRMA clip. One is a few hundred KB to a few MB.
CLIP_MAX_BYTES = int(os.getenv("CHARACTER_CLIP_MAX_BYTES", str(16 * MIB)))

#: VRM bytes one account may store across all its personas. Registration is open
#: by default, so an unmetered store is a way to fill the host's disk. Pose art
#: is not metered, as before.
QUOTA_BYTES = int(os.getenv("CHARACTER_ASSETS_QUOTA_BYTES", str(1024 * MIB)))

#: Largest JSON chunk parsed. VRoid's are well under a megabyte.
JSON_MAX_BYTES = int(os.getenv("CHARACTER_MODEL_JSON_MAX_BYTES", str(16 * MIB)))

#: The three pose-graph upload routes read their body into memory to decode it;
#: these bound what they will read.
IMAGE_MAX_BYTES = int(os.getenv("CHARACTER_IMAGE_MAX_BYTES", str(16 * MIB)))
VIDEO_MAX_BYTES = int(os.getenv("CHARACTER_VIDEO_MAX_BYTES", str(32 * MIB)))

#: Strings lifted from an uploaded file are cut to this before they are stored
#: or returned: they come from an untrusted file.
META_MAX_CHARS = 256
FILENAME_MAX_CHARS = 128

GLTF_MAGIC = 0x46546C67  # b"glTF", little-endian
CHUNK_JSON = 0x4E4F534A  # b"JSON", little-endian
HEADER_BYTES = 12
CHUNK_HEADER_BYTES = 8

MEDIA_TYPE = "model/gltf-binary"

_SHA256 = re.compile(r"[0-9a-f]{64}")

# VRM 1.0 preset names are the wire's six emotions already; 0.x names its own.
EMOTIONS = ("neutral", "happy", "angry", "sad", "relaxed", "surprised")
_VRM0_PRESETS = {"neutral": "neutral", "joy": "happy", "angry": "angry", "sorrow": "sad", "fun": "relaxed"}


def refusal(status: int, code: str, message: str, **extra) -> HTTPException:
    """An ``HTTPException`` whose detail is ``{code, message, ...}``."""
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def too_large(max_bytes: int, what: str) -> HTTPException:
    return refusal(
        413, "too_large",
        f"That {what} is larger than the {max_bytes // MIB} MB limit.",
        max_bytes=max_bytes,
    )


def over_quota(used: int, quota: int) -> HTTPException:
    return refusal(
        507, "quota",
        "Your 3D character storage is full. Remove a model or an animation first.",
        used_bytes=used, quota_bytes=quota,
    )


def _truncate(value, limit: int = META_MAX_CHARS) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    return value[:limit]


def display_filename(value: Optional[str], fallback: str) -> str:
    """A name to show for an upload: the client's, cut short, or ``fallback``."""
    name = (value or "").strip()
    name = "".join(ch for ch in name if ord(ch) >= 32 and ord(ch) != 127)
    return name[:FILENAME_MAX_CHARS] or fallback


# ── reading the file ─────────────────────────────────────────────────────────


def read_glb_json(path: Path, max_json: Optional[int] = None) -> dict:
    """The JSON chunk of a glTF 2.0 binary, bounded; raises 415 otherwise.

    Blocking — call it in a worker thread. ``max_json`` defaults to
    ``JSON_MAX_BYTES`` read at call time.
    """
    limit = JSON_MAX_BYTES if max_json is None else max_json
    size = path.stat().st_size
    with open(path, "rb") as handle:
        header = handle.read(HEADER_BYTES)
        if len(header) < HEADER_BYTES:
            raise refusal(415, "not_glb", "That file is not a 3D model (glTF binary).")
        magic, version, _declared = struct.unpack("<III", header)
        if magic != GLTF_MAGIC or version != 2:
            raise refusal(415, "not_glb", "That file is not a 3D model (glTF 2.0 binary).")
        chunk_header = handle.read(CHUNK_HEADER_BYTES)
        if len(chunk_header) < CHUNK_HEADER_BYTES:
            raise refusal(415, "bad_json", "The model's description is missing.")
        chunk_len, chunk_type = struct.unpack("<II", chunk_header)
        if chunk_type != CHUNK_JSON:
            raise refusal(415, "bad_json", "The model's description is missing.")
        if chunk_len > size - HEADER_BYTES - CHUNK_HEADER_BYTES or chunk_len > limit:
            raise refusal(415, "bad_json", "The model's description is damaged or too large.")
        raw = handle.read(chunk_len)
    if len(raw) != chunk_len:
        raise refusal(415, "bad_json", "The model's description is damaged.")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (RecursionError, ValueError, UnicodeDecodeError):
        raise refusal(415, "bad_json", "The model's description could not be read.")
    if not isinstance(document, dict):
        raise refusal(415, "bad_json", "The model's description could not be read.")
    return document


@dataclass(frozen=True)
class ModelInfo:
    spec_version: str
    expressions: list[str]
    meta: dict = field(default_factory=dict)


def _extensions(document: dict) -> dict:
    extensions = document.get("extensions")
    return extensions if isinstance(extensions, dict) else {}


def inspect_model(document: dict) -> ModelInfo:
    """Which VRM this is, which of the six faces it has, and its meta; 415 when not a movable VRM."""
    extensions = _extensions(document)
    if isinstance(extensions.get("VRMC_vrm"), dict):
        return _inspect_vrm1(extensions["VRMC_vrm"])
    if isinstance(extensions.get("VRM"), dict):
        return _inspect_vrm0(extensions["VRM"])
    raise refusal(
        415, "not_vrm",
        "That file is a 3D model but not a VRM. Export it from VRoid Studio as VRM and upload that file.",
    )


def _no_humanoid() -> HTTPException:
    return refusal(
        415, "no_humanoid",
        "That VRM has no skeleton set up, so it could not move. Export it again without changing the bones.",
    )


def _inspect_vrm1(vrm: dict) -> ModelInfo:
    humanoid = vrm.get("humanoid")
    bones = humanoid.get("humanBones") if isinstance(humanoid, dict) else None
    if not isinstance(bones, dict) or not isinstance(bones.get("hips"), dict):
        raise _no_humanoid()
    expressions = vrm.get("expressions")
    presets = expressions.get("preset") if isinstance(expressions, dict) else None
    present = set(presets) if isinstance(presets, dict) else set()
    meta = vrm.get("meta") if isinstance(vrm.get("meta"), dict) else {}
    authors = meta.get("authors")
    return ModelInfo(
        spec_version="1.0",
        expressions=[name for name in EMOTIONS if name in present],
        meta={
            "spec_version": "1.0",
            "title": _truncate(meta.get("name")),
            "authors": [_truncate(a) for a in authors[:16]] if isinstance(authors, list) else [],
            "license_name": None,
            "license_url": _truncate(meta.get("licenseUrl")),
            "avatar_permission": _truncate(meta.get("avatarPermission")),
            "commercial_usage": _truncate(meta.get("commercialUsage")),
        },
    )


def _inspect_vrm0(vrm: dict) -> ModelInfo:
    humanoid = vrm.get("humanoid")
    bones = humanoid.get("humanBones") if isinstance(humanoid, dict) else None
    if not isinstance(bones, list) or not any(
        isinstance(b, dict) and b.get("bone") == "hips" for b in bones
    ):
        raise _no_humanoid()
    master = vrm.get("blendShapeMaster")
    groups = master.get("blendShapeGroups") if isinstance(master, dict) else None
    present = set()
    if isinstance(groups, list):
        for group in groups:
            if isinstance(group, dict):
                mapped = _VRM0_PRESETS.get(str(group.get("presetName", "")).lower())
                if mapped:
                    present.add(mapped)
    meta = vrm.get("meta") if isinstance(vrm.get("meta"), dict) else {}
    author = meta.get("author")
    return ModelInfo(
        spec_version="0.x",
        expressions=[name for name in EMOTIONS if name in present],
        meta={
            "spec_version": "0.x",
            "title": _truncate(meta.get("title")),
            "authors": [_truncate(author)] if author else [],
            "license_name": _truncate(meta.get("licenseName")),
            "license_url": _truncate(meta.get("otherLicenseUrl")),
            "avatar_permission": _truncate(meta.get("allowedUserName")),
            "commercial_usage": _truncate(meta.get("commercialUssageName")),
        },
    )


def inspect_model_file(path: Path) -> ModelInfo:
    """``read_glb_json`` then ``inspect_model``. Blocking."""
    return inspect_model(read_glb_json(path))


def inspect_clip_file(path: Path) -> None:
    """415 unless the file is a glTF binary carrying a VRM animation. Blocking."""
    document = read_glb_json(path)
    if not isinstance(_extensions(document).get("VRMC_vrm_animation"), dict):
        raise refusal(
            415, "not_vrma",
            "That file is not a VRM animation (.vrma).",
        )


# ── the refs ─────────────────────────────────────────────────────────────────


def model_url(persona_id: int) -> str:
    return f"/character-assets/{persona_id}/vrm/model"


def clip_url(persona_id: int, clip_id: str) -> str:
    return f"/character-assets/{persona_id}/vrma/{clip_id}"


def model_path(persona_dir: Path, sha256: str) -> Path:
    """Where a model with this digest lives. Content-addressed: a replacement is a new
    file beside the old one, never a rewrite of the path the served ref names, so
    the bytes a GET streams always hash to the ``ETag`` it sends. The public URL
    stays ``…/vrm/model``; the stored ref's sha picks the file."""
    return persona_dir / "vrm" / f"{sha256}.vrm"


def stored_model_path(persona_dir: Path, ref: Optional[dict]) -> Optional[Path]:
    """The file a stored model ref names, or ``None`` when the ref has no valid sha."""
    sha = ref.get("sha256") if isinstance(ref, dict) else None
    if not isinstance(sha, str) or not _SHA256.fullmatch(sha):
        return None
    return model_path(persona_dir, sha)


def clip_path(persona_dir: Path, clip_id: str) -> Path:
    return persona_dir / "vrma" / f"{clip_id}.vrma"


def vrm_member(config) -> Optional[dict]:
    """The stored ``vrm`` member, or ``None`` when there is none (or it is not an object)."""
    if not isinstance(config, dict):
        return None
    vrm = config.get("vrm")
    return vrm if isinstance(vrm, dict) else None


def stored_model(config) -> Optional[dict]:
    vrm = vrm_member(config)
    model = vrm.get("model") if vrm else None
    return model if isinstance(model, dict) else None


def stored_clips(config) -> list[dict]:
    vrm = vrm_member(config)
    clips = vrm.get("clips") if vrm else None
    return [c for c in clips if isinstance(c, dict)] if isinstance(clips, list) else []


def _ref_bytes(ref: Optional[dict]) -> int:
    if not ref:
        return 0
    value = ref.get("bytes")
    return value if isinstance(value, int) and value > 0 else 0


def persona_bytes(config) -> int:
    """VRM bytes one persona's stored refs account for."""
    return _ref_bytes(stored_model(config)) + sum(_ref_bytes(c) for c in stored_clips(config))


def account_usage(personas) -> tuple[int, list[dict]]:
    """``(used_bytes, per_persona)`` over a user's persona rows."""
    per = [{"persona_id": p.id, "bytes": persona_bytes(p.character_config)} for p in personas]
    return sum(entry["bytes"] for entry in per), per


def with_vrm(config, update) -> dict:
    """A copy of ``config`` whose ``vrm`` member ``update`` has changed.

    A persona that has never had a VRM member gets one with the schema's
    defaults; one with no config at all becomes ``kind: vrm``. ``kind`` is
    otherwise left alone — uploading a model does not switch what shows.
    """
    from kurisuassistant.character.schema import VrmSettings

    base = json.loads(json.dumps(config)) if isinstance(config, dict) else {"kind": "vrm"}
    vrm = base.get("vrm") if isinstance(base.get("vrm"), dict) else VrmSettings().model_dump(mode="json")
    update(vrm)
    base["vrm"] = vrm
    return base


def clip_in_use(config, clip_id: str) -> bool:
    """Whether the idle rotation or a reaction still plays this clip."""
    vrm = vrm_member(config) or {}
    idle = vrm.get("idle") if isinstance(vrm.get("idle"), dict) else {}
    if clip_id in (idle.get("idle_clip_ids") or []):
        return True
    for reaction in vrm.get("reactions") or []:
        play = reaction.get("play") if isinstance(reaction, dict) else None
        if isinstance(play, dict) and play.get("type") == "clip" and play.get("clip_id") == clip_id:
            return True
    return False
