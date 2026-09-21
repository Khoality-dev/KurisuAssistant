"""The one way ``character_config`` is written.

Two routes accept the column — ``PATCH /character-assets/{id}/character-config``
and ``PATCH /personas/{id}`` (plus ``POST /personas``) — and both used to have
their own idea of what a save meant: one swept the asset directory, the other
did not. Now both plan the write here, write what the plan produced, and sweep
afterwards with the set the plan handed them.

A save is a **merge per member**, not a replacement. ``kind`` is a selector and
may change freely; ``pose_tree`` and ``vrm`` are kept when a body leaves them
out and cleared when it sends ``null`` — so the graph editor's autosave, which
knows nothing about VRM settings, cannot erase them, and a kind change removes
nothing that either member still references. ``vrm.model`` and ``vrm.clips``
are server-owned: whatever a body says, the stored values win.
"""

import logging
from dataclasses import dataclass
from typing import Optional

import anyio
from fastapi import HTTPException
from pydantic import ValidationError

from kurisuassistant.character.references import (
    classify,
    cleanup_persona_assets,
    remove_persona_assets,
)
from kurisuassistant.character.schema import CharacterConfigBody, clip_ids_named

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PlannedWrite:
    """What the row will hold, and which files that config keeps."""

    config: Optional[dict]
    referenced: set[str]


def _invalid(detail) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def merge_character_config(stored, body: dict) -> dict:
    """The stored config with one body applied: ``kind`` replaced, members merged.

    Raises 422 for a body without a recognised ``kind``, a member of the wrong
    shape, a VRM key this server does not know, or a clip id the stored clips
    do not contain.
    """
    try:
        parsed = CharacterConfigBody.model_validate(body)
    except ValidationError as exc:
        # No ``ctx``: a validator's own ``ValueError`` rides in it and is not
        # JSON, which would turn this 422 into a 500 at the response.
        raise _invalid(exc.errors(include_url=False, include_input=False, include_context=False))

    previous = stored if isinstance(stored, dict) else {}
    merged: dict = {
        key: value for key, value in previous.items() if key in ("pose_tree", "vrm")
    }
    merged["kind"] = parsed.kind

    if "pose_tree" in body:
        if parsed.pose_tree is None:
            merged.pop("pose_tree", None)
        else:
            merged["pose_tree"] = parsed.pose_tree

    if "vrm" in body:
        if parsed.vrm is None:
            merged.pop("vrm", None)
        else:
            stored_vrm = previous.get("vrm") if isinstance(previous.get("vrm"), dict) else {}
            settings = parsed.vrm.model_dump(mode="json")
            settings["model"] = stored_vrm.get("model")
            settings["clips"] = list(stored_vrm.get("clips") or [])
            stored_ids = {clip.get("id") for clip in settings["clips"] if isinstance(clip, dict)}
            unknown = clip_ids_named(parsed.vrm) - stored_ids
            if unknown:
                raise _invalid(f"Unknown clip id(s): {', '.join(sorted(unknown))}.")
            merged["vrm"] = settings

    return merged


def plan_character_config(persona_id: Optional[int], body, stored=None) -> PlannedWrite:
    """Validate a config about to be written and return what to write and what it keeps.

    ``None`` (the client clearing the column) writes NULL and keeps nothing: the
    empty set. Anything else is merged over ``stored`` (§ module docstring) and
    then classified by the walker; a merged config it cannot classify — a member
    that is not the shape the clients write, or one pointing at another
    persona's assets — is refused with 422 before anything is written, so a bad
    save can never reach the sweep. The detail names the member and the cause,
    because the member at fault may be one the body never sent: a stored member
    the walker refuses has to be cleared (``null``) before anything else saves.
    """
    if body is None:
        return PlannedWrite(config=None, referenced=set())
    if not isinstance(body, dict):
        raise _invalid("character_config must be an object or null.")
    merged = merge_character_config(stored, body)
    classification = classify(persona_id, merged)
    if classification.refs is None:
        raise _invalid(classification.refusal)
    return PlannedWrite(config=merged, referenced=classification.refs)


async def cleanup_after_write(persona_id: int, referenced: set[str]) -> None:
    """Sweep the persona's directory once the row is committed.

    Off the event loop: the walk touches every file the persona owns, and the
    VRM store will put tens of megabytes there. Never raises — the row is
    already written, so the response is a success whatever the disk said; the
    sweep logs what it could not do and the next save tries again.
    """
    try:
        await anyio.to_thread.run_sync(cleanup_persona_assets, persona_id, referenced)
    except Exception:  # noqa: BLE001 — a committed save must not turn into a 500
        logger.exception("persona %d: asset cleanup failed after the config was saved", persona_id)


async def remove_after_delete(persona_id: int) -> int:
    """Reclaim a deleted persona's directory, off the event loop; returns the bytes.

    Never raises: the row is already gone, so the response must say so whatever
    the disk did. ``remove_persona_assets`` logs what it could not remove.
    """
    try:
        return await anyio.to_thread.run_sync(remove_persona_assets, persona_id)
    except Exception:  # noqa: BLE001 — a failed reclaim is a log line, not a failed delete
        logger.exception("persona %d deleted; reclaiming its character assets failed", persona_id)
        return 0
