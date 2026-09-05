"""Persona selection for a conversation.

Runs when a conversation has no ``persona_id`` yet, or when the client sends
an explicit override. The order is fixed and deterministic:

1. an explicit override — the conversation's existing binding, or the
   ``persona_id`` on this ``chat_request``;
2. the user's ``assistants.default_persona_id``;
3. the user's first enabled persona, by id, so the same input always yields
   the same persona;
4. otherwise ``ValueError`` — a user with no enabled persona has no voice.

There is no trigger-word scan here and no random fallback. The trigger word is
a voice *wake word* and lives on the assistant: saying it wakes the assistant
and the conversation's bound persona answers. A new conversation silently
adopts the default persona; nothing rolls dice.
"""

import logging
from typing import Iterable, List, Optional

from .base import PersonaConfig

logger = logging.getLogger(__name__)


def _by_id(personas: Iterable[PersonaConfig]) -> List[PersonaConfig]:
    """Personas ordered by id — the tie-break that makes step 3 deterministic."""
    return sorted(personas, key=lambda p: (p.id is None, p.id or 0))


def pick_persona(
    personas: List[PersonaConfig],
    override_id: Optional[int] = None,
    default_persona_id: Optional[int] = None,
) -> PersonaConfig:
    """Pick the persona that answers in a conversation.

    Args:
        personas: The user's enabled personas. Only these are eligible; a
            disabled persona cannot be revived by pointing at its id.
        override_id: An explicit choice — the conversation's stored binding or
            the id on this request. Ignored with a warning if it names a
            persona that is not enabled (deleted, disabled, or another user's).
        default_persona_id: ``assistants.default_persona_id``. Same treatment
            if it dangles.

    Returns:
        The chosen PersonaConfig.

    Raises:
        ValueError: If ``personas`` is empty.
    """
    if not personas:
        raise ValueError("No enabled personas available for selection")

    ordered = _by_id(personas)
    by_id = {p.id: p for p in ordered if p.id is not None}

    if override_id is not None:
        chosen = by_id.get(override_id)
        if chosen is not None:
            return chosen
        logger.warning(
            "Requested persona %s is not enabled for this user — falling back",
            override_id,
        )

    if default_persona_id is not None:
        chosen = by_id.get(default_persona_id)
        if chosen is not None:
            return chosen
        logger.warning(
            "Default persona %s is not enabled for this user — falling back",
            default_persona_id,
        )

    chosen = ordered[0]
    logger.info("No persona pinned — using '%s' (id=%s)", chosen.name, chosen.id)
    return chosen
