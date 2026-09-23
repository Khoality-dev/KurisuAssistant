"""Who answers when a persona is optional (#302).

A persona is a presentation layer — a name, a voice, a character — and the
assistant does not need one to hold a conversation. When nothing pins a persona,
``pick_persona`` answers with the assistant itself: no id, named "Assistant",
no prompt of its own. It used to fall back to the first enabled persona, and to
refuse outright when there was none.
"""

from kurisuassistant.agents.base import AgentContext, AssistantConfig, PersonaConfig
from kurisuassistant.agents.main import MainAgent
from kurisuassistant.agents.selection import ASSISTANT_NAME, pick_persona
from kurisuassistant.tools import ToolRegistry

KURISU = PersonaConfig(id=1, name="Kurisu", system_prompt="Be sarcastic.")
MAYURI = PersonaConfig(id=2, name="Mayuri")


class TestPickPersona:
    def test_no_personas_is_the_assistant_itself(self):
        chosen = pick_persona([])
        assert chosen.id is None
        assert chosen.name == ASSISTANT_NAME == "Assistant"
        assert chosen.system_prompt == "" and chosen.voice_reference is None
        assert chosen.character_config is None

    def test_no_default_is_the_assistant_not_the_first_persona(self):
        assert pick_persona([KURISU, MAYURI]).id is None

    def test_the_default_answers(self):
        assert pick_persona([KURISU, MAYURI], default_persona_id=2) is MAYURI

    def test_an_override_beats_the_default(self):
        assert pick_persona([KURISU, MAYURI], override_id=1, default_persona_id=2) is KURISU

    def test_a_default_that_is_not_enabled_falls_back_to_the_assistant(self):
        assert pick_persona([KURISU], default_persona_id=9).id is None

    def test_an_override_that_is_not_enabled_falls_back_to_the_default(self):
        assert pick_persona([KURISU, MAYURI], override_id=9, default_persona_id=2) is MAYURI

    def test_each_turn_gets_its_own_assistant_identity(self):
        """A dataclass is mutable; one shared instance would carry a turn's edits into the next."""
        assert pick_persona([]) is not pick_persona([])


async def system_prompt(identity):
    agent = MainAgent(AssistantConfig(id=1), ToolRegistry(), identity=identity)
    prepared = await agent._prepare_messages(
        [{"role": "user", "content": "hi"}],
        AgentContext(user_id=None, model_name="m", user_system_prompt="Answer in English.", preferred_name="Khoa"),
    )
    return prepared[0]["content"]


class TestTheAssistantsPrompt:
    async def test_the_assistant_speaks_as_itself(self):
        prompt = await system_prompt(pick_persona([]))
        assert prompt.startswith("You are the user's personal assistant.")
        assert "You are Assistant." not in prompt

    async def test_the_accounts_own_settings_still_apply(self):
        prompt = await system_prompt(pick_persona([]))
        assert "Answer in English." in prompt
        assert "The user prefers to be called: Khoa" in prompt

    async def test_a_persona_still_speaks_as_itself(self):
        prompt = await system_prompt(KURISU)
        assert prompt.startswith("You are Kurisu.\n\nBe sarcastic.")
