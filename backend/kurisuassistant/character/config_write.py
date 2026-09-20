"""The one way ``character_config`` is written.

Two routes accept the column — ``PATCH /character-assets/{id}/character-config``
and ``PATCH /personas/{id}`` (plus ``POST /personas``) — and both used to have
their own idea of what a save meant: one swept the asset directory, the other
did not. Now both classify the body here before writing, write, and sweep
afterwards with the set this module handed them.
"""

import logging
from typing import Optional

import anyio
from fastapi import HTTPException

from kurisuassistant.character.references import (
    cleanup_persona_assets,
    referenced_paths,
    remove_persona_assets,
)

logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)


def plan_character_config(persona_id: Optional[int], body) -> set[str]:
    """Validate a config about to be written and return the files it keeps.

    ``None`` (the client clearing the column) keeps nothing: the empty set. A
    body the walker cannot classify — not a pose-tree config, or one pointing
    at another persona's assets — is refused with 422 before anything is
    written, so a bad save can never reach the sweep.
    """
    if body is None:
        return set()
    refs = referenced_paths(persona_id, body)
    if refs is None:
        raise HTTPException(
            status_code=422,
            detail="character_config must be a pose-tree config whose asset URLs belong to this persona.",
        )
    return refs


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
