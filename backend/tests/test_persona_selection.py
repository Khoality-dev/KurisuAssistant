"""Who answers: the persona in use for the whole account, or the assistant (#302, #354).

A persona is a presentation layer — a name, a voice, a character — and the
assistant does not need one to hold a conversation. One persona, or none, is in
use for the whole account (``assistants.selected_persona_id``); every turn, in
any conversation, answers as it. With none in use, ``persona_in_use`` answers
with the assistant itself: no id, named "Assistant", no prompt of its own.
"""

from kurisuassistant.agents.base import AgentContext, AssistantConfig, PersonaConfig
from kurisuassistant.agents.main import MainAgent
from kurisuassistant.agents.selection import ASSISTANT_NAME, persona_in_use
from kurisuassistant.tools import ToolRegistry

KURISU = PersonaConfig(id=1, name="Kurisu", system_prompt="Be sarcastic.")
MAYURI = PersonaConfig(id=2, name="Mayuri")


class TestPersonaInUse:
    def test_no_personas_is_the_assistant_itself(self):
        chosen = persona_in_use([], None)
        assert chosen.id is None
        assert chosen.name == ASSISTANT_NAME == "Assistant"
        assert chosen.system_prompt == "" and chosen.voice_reference is None
        assert chosen.character_config is None

    def test_none_in_use_is_the_assistant_not_the_first_persona(self):
        assert persona_in_use([KURISU, MAYURI], None).id is None

    def test_the_persona_in_use_answers(self):
        assert persona_in_use([KURISU, MAYURI], 2) is MAYURI

    def test_a_persona_in_use_that_is_not_enabled_falls_back_to_the_assistant(self):
        # Not to another persona: the server never picks one nobody chose (#334).
        assert persona_in_use([KURISU, MAYURI], 9).id is None

    def test_each_turn_gets_its_own_assistant_identity(self):
        """A dataclass is mutable; one shared instance would carry a turn's edits into the next."""
        assert persona_in_use([], None) is not persona_in_use([], None)


async def system_prompt(identity):
    agent = MainAgent(AssistantConfig(id=1), ToolRegistry(), identity=identity)
    prepared = await agent._prepare_messages(
        [{"role": "user", "content": "hi"}],
        AgentContext(user_id=None, model_name="m", user_system_prompt="Answer in English.", preferred_name="Khoa"),
    )
    return prepared[0]["content"]


class TestTheAssistantsPrompt:
    async def test_the_assistant_speaks_as_itself(self):
        prompt = await system_prompt(persona_in_use([], None))
        assert prompt.startswith("You are the user's personal assistant.")
        assert "You are Assistant." not in prompt

    async def test_the_accounts_own_settings_still_apply(self):
        prompt = await system_prompt(persona_in_use([], None))
        assert "Answer in English." in prompt
        assert "The user prefers to be called: Khoa" in prompt

    async def test_a_persona_still_speaks_as_itself(self):
        prompt = await system_prompt(KURISU)
        assert prompt.startswith("You are Kurisu.\n\nBe sarcastic.")
