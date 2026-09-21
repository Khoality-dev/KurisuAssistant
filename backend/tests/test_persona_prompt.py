"""What ``MainAgent._prepare_messages`` puts in the system prompt for a persona.

The first test of that method's persona-dependent parts. The one thing pinned
so far is the emotion channel's gate (#243): the ``## Expression`` block, which
asks the model to tag its feelings, appears only for a VRM persona whose
emotion setting is on. A pose-graph persona's prompt is byte-identical to a
backend that never had the channel — the tags are stripped by a reader that
exists only when the block was sent, so a prompt that asks without a reader
(or the reverse) would show tags to the user. No model is involved.
"""

from kurisuassistant.agents.base import AssistantConfig, PersonaConfig, AgentContext
from kurisuassistant.agents.main import EXPRESSION_PROMPT, MainAgent
from kurisuassistant.tools import ToolRegistry


def agent(character_config):
    return MainAgent(
        AssistantConfig(id=1),
        ToolRegistry(),
        identity=PersonaConfig(id=1, name="Tester", character_config=character_config),
    )


async def system_prompt(character_config):
    prepared = await agent(character_config)._prepare_messages(
        [{"role": "user", "content": "hi"}], AgentContext(user_id=None, model_name="m"),
    )
    assert prepared[0]["role"] == "system"
    return prepared[0]["content"]


def vrm(enabled):
    return {"kind": "vrm", "vrm": {"emotion": {"enabled": enabled}}}


class TestTheExpressionBlock:
    async def test_asked_of_a_vrm_persona_with_emotion_on(self):
        prompt = await system_prompt(vrm(True))
        assert EXPRESSION_PROMPT in prompt
        assert "[[emotion:happy]]" in prompt

    async def test_not_asked_when_emotion_is_off(self):
        assert "## Expression" not in await system_prompt(vrm(False))

    async def test_not_asked_of_a_pose_graph_persona(self):
        assert "## Expression" not in await system_prompt(
            {"kind": "pose_graph", "pose_tree": {"default_pose_ids": [], "nodes": [], "edges": []}}
        )

    async def test_not_asked_of_a_persona_with_no_character(self):
        assert "## Expression" not in await system_prompt(None)

    async def test_a_persona_without_the_channel_gets_the_same_prompt_as_before(self):
        """The block is the only difference between the two prompts."""
        with_channel = await system_prompt(vrm(True))
        without = await system_prompt(vrm(False))
        # The prompt carries the current time; strip that line before comparing.
        strip = lambda s: "\n".join(l for l in s.splitlines() if not l.startswith("Current time:"))
        assert strip(with_channel).replace("\n\n" + EXPRESSION_PROMPT, "") == strip(without)

    def test_the_source_is_created_only_alongside_the_block(self):
        """Prompt and reader are one decision: ask, and read; or neither."""
        assert agent(vrm(True))._new_emotion_source() is not None
        assert agent(vrm(False))._new_emotion_source() is None
        assert agent(None)._new_emotion_source() is None
