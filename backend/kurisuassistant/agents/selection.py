"""Who answers: the persona in use for the whole account (#354).

A persona is optional (#302): it is a name, a voice and a character the
assistant can answer in. One persona, or none, is in use for the whole account —
``assistants.selected_persona_id`` — and every turn answers as it, in a new
conversation or an old one, on every device. A conversation is not tied to a
persona and a request cannot name one; switching is the account's, and it
applies everywhere at once.

There is no fallback to "the first persona", and nothing raises: an account with
no persona in use, or one that is no longer enabled, is answered by the
assistant itself. There is no trigger-word scan and no random pick either. The
trigger word is a voice *wake word* and lives on the assistant.
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


def persona_in_use(
    personas: List[PersonaConfig],
    selected_id: Optional[int],
) -> PersonaConfig:
    """The persona every turn answers as, or the assistant itself.

    Args:
        personas: The user's enabled personas. Only these are eligible; a
            disabled persona cannot be revived by pointing at its id.
        selected_id: ``assistants.selected_persona_id``. Ignored with a warning
            if it names a persona that is not enabled — the routes clear it on
            disable and delete, so this is a race, not a state to keep.

    Returns:
        The persona in use, or :func:`assistant_identity` when there is none.
    """
    if selected_id is not None:
        chosen = next((p for p in personas if p.id == selected_id), None)
        if chosen is not None:
            return chosen
        logger.warning(
            "Persona %s is in use but not enabled for this user — the assistant answers",
            selected_id,
        )

    return assistant_identity()
