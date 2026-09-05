"""What an account needs before it can hold a conversation.

An account is not usable on its own. Chatting needs two rows that no user action
creates: the one ``assistants`` row that holds the model, the tools and the memory,
and at least one persona for a conversation to bind to. A new conversation reads
``assistants.default_persona_id`` silently — there is no picker and no fallback —
so an account missing either row can log in, see an empty chat, and get nothing
back when it sends a message.

Every path that mints an account calls :func:`provision_user`: registration, and
the seeded ``admin`` at startup. It is idempotent, so calling it on an account that
is already whole costs one query and changes nothing.
"""

import logging
from typing import Iterable

from kurisuassistant.db.repositories import AssistantRepository, PersonaRepository

logger = logging.getLogger(__name__)

#: Names the app uses for speakers that are not one of the user's personas, so a
#: persona or sub-agent may not take them. Mirrored case-insensitively by
#: RESERVED_PERSONA_NAMES in migration 0dacee9f63b8.
RESERVED_AGENT_NAMES = {"Administrator", "User", "App Guide"}

#: What the first persona is called. Matches the name migration 0dacee9f63b8 seeds,
#: so an account created before and after the split looks the same.
DEFAULT_PERSONA_NAME = "Assistant"


def unique_persona_name(taken: Iterable[str], base: str = DEFAULT_PERSONA_NAME) -> str:
    """A persona name free of collisions with ``taken`` and the reserved names.

    Compared case-insensitively: ``personas`` is unique on (user_id, name) exactly,
    but a name that only differs in case from a reserved one would still be refused
    by the API later, which would leave the user with a persona they cannot rename.
    """
    lowered = {name.lower() for name in taken} | {n.lower() for n in RESERVED_AGENT_NAMES}
    name = base
    suffix = 2
    while name.lower() in lowered:
        name = f"{base} {suffix}"
        suffix += 1
    return name


def provision_user(session, user) -> None:
    """Give ``user`` an assistant and a default persona if they lack either.

    Args:
        session: Open SQLAlchemy session; the caller owns the transaction
        user: The freshly created (or existing) User row
    """
    persona_repo = PersonaRepository(session)
    assistant_repo = AssistantRepository(session)

    personas = persona_repo.list_by_user(user.id)
    if not personas:
        # The seed mirrors the migration's: the user's own profile is the only
        # material available, and it is what the client already shows as "the
        # assistant" for accounts that predate personas.
        persona = persona_repo.create_persona(
            user_id=user.id,
            name=unique_persona_name([]),
            system_prompt=user.system_prompt or "",
            preferred_name=user.preferred_name or None,
            avatar_uuid=user.agent_avatar_uuid,
        )
        logger.info("provisioned persona %r (id=%s) for user %s",
                    persona.name, persona.id, user.username)
        personas = [persona]

    assistant = assistant_repo.get_or_create_for_user(user.id)
    if assistant.default_persona_id is None:
        assistant_repo.update_assistant(assistant, default_persona_id=personas[0].id)
        logger.info("assistant for user %s now defaults to persona %s",
                    user.username, personas[0].id)

