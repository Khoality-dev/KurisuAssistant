"""What an account needs before it can hold a conversation.

An account is not usable on its own. Chatting needs two rows that no user action
creates: the one ``assistants`` row that holds the model, the tools and the memory,
and at least one persona for a conversation to bind to. A new conversation reads
``assistants.default_persona_id`` silently — there is no picker and no fallback —
so an account missing either row can log in, see an empty chat, and get nothing
back when it sends a message.

Provisioning fills both rows but cannot fill the **model**: which one to use is a
choice about the operator's own providers, and at registration there is no
provider to ask and no answer to guess. So every new account starts with
``assistants.model_name`` NULL and its first message cannot be answered. That is a
setup step, not a fault, and the server says so in as many words rather than
failing somewhere inside the provider — see :data:`NO_MODEL_SELECTED_DETAIL` and
the ``NO_MODEL_SELECTED`` WebSocket error (#149).

There is exactly one path that mints an account — registration — and it calls
:func:`provision_user` in the same transaction. (There used to be a second: a
seeded ``admin`` account at startup, removed in #148.) It is idempotent, so
calling it on an account that is already whole costs one query and changes
nothing.
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


# The one sentence a user sees while their account is waiting. It is a user's
# whole explanation of why a correct password does not let them in, so it says
# who can fix it rather than only that something is wrong.
ACCOUNT_INACTIVE_DETAIL = (
    "This account is not activated yet. Ask the server operator to activate it."
)

# What a brand-new account gets back for its very first message. Same rule as
# above: name the empty field and where to fill it, because the alternative — the
# generic failure this replaces — reads as "the software is broken" rather than
# "one setting is blank". Clients that recognise ``NO_MODEL_SELECTED`` turn this
# into a button onto that screen; the rest still show a sentence that answers the
# question on its own.
#
# It names the screen and not a path to it, because the path differs: the screen
# is Settings → Assistant on desktop and a top-level drawer entry on Android. Each
# client spells out its own route in its own copy.
NO_MODEL_SELECTED_DETAIL = (
    "No model is selected yet. Choose one on the Assistant screen, then send your "
    "message again."
)
