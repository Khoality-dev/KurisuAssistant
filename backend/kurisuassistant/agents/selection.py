"""Persona selection for a conversation.

A persona is optional (#302): it is a name, a voice and a character the
assistant can answer in, and the assistant answers as itself when none is
pinned. The order is fixed and deterministic:

1. an explicit override — the conversation's existing binding, or the
   ``persona_id`` on this ``chat_request``;
2. otherwise the assistant itself: :func:`assistant_identity`.

``assistants.selected_persona_id`` is not a step: it is who the account's chat
is on, and a client that means it names it. The server used to adopt the
account's default persona for a chat that named nobody, which put a persona
behind a header that said "Assistant" (#334).

There is no fallback to "the first persona" any more, and nothing raises: an
account with no persona, or none enabled, is answered by the assistant. There is
no trigger-word scan and no random pick either. The trigger word is a voice
*wake word* and lives on the assistant.
"""

import logging
from typing import List, Optional

from .base import PersonaConfig

logger = logging.getLogger(__name__)

#: What the assistant is called when it answers as itself, on the wire
#: (``stream_chunk.name`` / ``persona_name``) and in stored messages.
ASSISTANT_NAME = "Assistant"


def assistant_identity() -> PersonaConfig:
    """The assistant speaking as itself: no id, no prompt, no voice, no character.

    A fresh object per call — a dataclass is mutable, and one shared instance
    would carry one turn's edits into the next.
    """
    return PersonaConfig(id=None, name=ASSISTANT_NAME)


def pick_persona(
    personas: List[PersonaConfig],
    override_id: Optional[int] = None,
) -> PersonaConfig:
    """Pick who answers in a conversation.

    Args:
        personas: The user's enabled personas. Only these are eligible; a
            disabled persona cannot be revived by pointing at its id.
        override_id: An explicit choice — the conversation's stored binding or
            the id on this request. Ignored with a warning if it names a
            persona that is not enabled (deleted, disabled, or another user's).

    Returns:
        The chosen persona, or :func:`assistant_identity` when nothing is pinned.
    """
    by_id = {p.id: p for p in personas if p.id is not None}

    if override_id is not None:
        chosen = by_id.get(override_id)
        if chosen is not None:
            return chosen
        logger.warning(
            "Requested persona %s is not enabled for this user — falling back",
            override_id,
        )

    return assistant_identity()
