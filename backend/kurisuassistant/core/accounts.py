"""What an account needs before it can hold a conversation.

An account is not usable on its own. Chatting needs one row that no user action
creates: the ``assistants`` row that holds the model, the tools and the memory.
A persona is optional (#302) — with none, the assistant answers as itself — so a
new account is given none, and ``assistants.default_persona_id`` starts NULL.

Provisioning creates that row but cannot fill the **model**: which one to use is
a choice about the operator's own providers, and at registration there is no
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

from kurisuassistant.db.repositories import AssistantRepository

#: Names the app uses for speakers that are not one of the user's personas, so a
#: persona or sub-agent may not take them. Mirrored case-insensitively by
#: RESERVED_PERSONA_NAMES in migration 0dacee9f63b8.
RESERVED_AGENT_NAMES = {"Administrator", "User", "App Guide"}


def provision_user(session, user) -> None:
    """Give ``user`` their assistant row if they lack it.

    No persona is made: the assistant answers as itself until the user creates
    one and chooses it (#302).

    Args:
        session: Open SQLAlchemy session; the caller owns the transaction
        user: The freshly created (or existing) User row
    """
    AssistantRepository(session).get_or_create_for_user(user.id)


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
