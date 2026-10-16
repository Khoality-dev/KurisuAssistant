"""SubAgent — a helper the assistant spawns on the spot (#354).

There are no saved sub-agents. When the assistant wants help it calls
``delegate_task`` with a task; :class:`DelegateTaskTool` spawns a fresh
:class:`SubAgent` on the assistant's own model and tools, runs it to an answer,
and hands that answer back as the tool result. The user sees only the
assistant's account of it, never the sub-agent's intermediate stream.

A sub-agent holds no memory and has no persona: it is never the speaker. It is
not offered ``delegate_task`` itself, because that tool is injected into the
assistant alone and is not in the registry the sub-agent draws on — a helper
cannot spawn helpers.
"""

import json
import logging
from typing import Any, Dict, List

from kurisuassistant.tools.base import BaseTool

from .base import AgentContext, AssistantConfig, BaseAgent, PersonaConfig, async_iterate

logger = logging.getLogger(__name__)

#: The name the model calls to spawn a sub-agent, and the tool policy key.
DELEGATE_TOOL_NAME = "delegate_task"

#: What a spawned sub-agent is told it is. It answers its caller, not the user.
SUB_AGENT_PROMPT = (
    "You are a sub-agent working for the user's assistant. You were given one task. "
    "Do it with the tools you have, then reply with the result alone: it goes back "
    "to the assistant, not to the user."
)


def worker_identity() -> PersonaConfig:
    """The label a spawned sub-agent runs under: no id, no voice, no character."""
    return PersonaConfig(id=None, name="Sub-agent", system_prompt=SUB_AGENT_PROMPT)


class SubAgent(BaseAgent):
    """Task-only agent. No persona, no memory, no streaming to the frontend.

    ``capabilities`` is the assistant's own :class:`AssistantConfig` — its model,
    provider, tool allowlist and reasoning switch — so a helper can do what the
    assistant can and nothing more. Its memory is never read here.
    """

    def __init__(self, assistant: AssistantConfig, tool_registry):
        super().__init__(assistant, tool_registry, identity=worker_identity())

    async def execute(self, task: str, context: AgentContext) -> str:
        """Run the sub-agent on a single task and return the final assistant text.

        Builds a minimal message list (its prompt + the task), runs the LLM
        tool-loop until completion, and accumulates the assistant content into a
        string. Does not yield events.
        """
        from kurisuassistant.models.llm import create_llm_provider

        model = self.capabilities.model_name or context.model_name
        provider_type = self.capabilities.provider_type or "ollama"

        api_key = None
        if provider_type == "gemini":
            api_key = context.gemini_api_key
        elif provider_type == "nvidia":
            api_key = context.nvidia_api_key
        elif provider_type == "poe":
            api_key = context.poe_api_key

        llm = create_llm_provider(provider_type, api_url=context.api_url, api_key=api_key)

        messages: List[Dict] = [
            {"role": "system", "content": self.identity.system_prompt},
            {"role": "user", "content": task},
        ]

        tool_schemas = self.tool_registry.get_schemas()

        # Server-side MCP tools
        if context.user_id:
            try:
                from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
                mcp_tools = await get_user_orchestrator(context.user_id).get_tools()
                tool_schemas.extend(mcp_tools)
            except Exception as e:
                logger.warning(f"SubAgent failed to load MCP tools: {e}")

        MAX_TOOL_ROUNDS = 10
        final_content = ""

        try:
            for _turn in range(MAX_TOOL_ROUNDS):
                stream = llm.chat(
                    model=model,
                    messages=messages,
                    tools=tool_schemas if tool_schemas else [],
                    stream=True,
                    think=self.capabilities.think,
                    options={"num_ctx": context.context_size or 8192},
                )

                full_content = ""
                full_thinking = ""
                all_tool_calls = []

                async for chunk in async_iterate(stream):
                    msg = chunk.message
                    thinking = getattr(msg, 'thinking', None)
                    if thinking:
                        full_thinking += thinking
                    if msg.content:
                        full_content += msg.content
                    if hasattr(msg, 'tool_calls') and msg.tool_calls:
                        all_tool_calls.extend(msg.tool_calls)

                if not all_tool_calls:
                    final_content = full_content
                    break

                assistant_msg = {"role": "assistant", "content": full_content}
                if full_thinking:
                    assistant_msg["thinking"] = full_thinking
                tc_list = []
                for tc in all_tool_calls:
                    args = tc.function.arguments
                    if isinstance(args, str):
                        args = json.loads(args)
                    tc_list.append({"function": {"name": tc.function.name, "arguments": args}})
                assistant_msg["tool_calls"] = tc_list
                messages.append(assistant_msg)

                denied_result = None
                for tc in all_tool_calls:
                    tool_name = tc.function.name
                    tool_args = tc.function.arguments
                    if isinstance(tool_args, str):
                        tool_args = json.loads(tool_args)

                    result = await self.execute_tool(tool_name, tool_args, context)
                    messages.append({"role": "tool", "content": result.content})
                    if result.status == "denied":
                        denied_result = result
                        break

                if denied_result is not None:
                    # Say why — the user said no, or the permission mode refused
                    # it — so the assistant can tell the user (#360).
                    final_content = full_content or f"Sub-agent stopped: {denied_result.content}"
                    break

            else:
                final_content = full_content or "Sub-agent hit max tool rounds without final answer."

        except Exception as e:
            logger.error(f"SubAgent execution failed: {e}", exc_info=True)
            return f"Sub-agent error: {e}"

        return final_content or "Sub-agent returned empty response."


class DelegateTaskTool(BaseTool):
    """The assistant's way to spawn a sub-agent: one task in, one answer out.

    Injected per turn by the chat handler as one of the assistant's
    ``extra_tools``, because it needs the assistant's own configuration to build
    the helper. It counts as only looking (``read_only``): it changes nothing
    itself, and every call the helper makes goes through the permission mode
    like the assistant's own (#360).
    """

    name = DELEGATE_TOOL_NAME
    description = (
        "Spawn a sub-agent to work on one self-contained task and return its result. "
        "It has your model and tools but none of this conversation: put everything it "
        "needs in the task. Use it for a side task you can hand off; answer simple "
        "things yourself."
    )
    read_only = True

    def __init__(self, assistant: AssistantConfig, tool_registry):
        self.assistant = assistant
        self.tool_registry = tool_registry

    @property
    def model_name(self):
        """The model a delegated step runs on — the assistant's own."""
        return self.assistant.model_name

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "The whole task, with every detail the sub-agent needs",
                        },
                    },
                    "required": ["task"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        task = args.get("task", "")
        context: AgentContext = args.get("_context")

        if not context:
            return "Error: No context provided for sub-agent execution"
        if not task:
            return "Error: No task provided"

        logger.info("Spawning a sub-agent for: %s...", task[:100])
        try:
            result = await SubAgent(self.assistant, self.tool_registry).execute(task, context)
            logger.info("Sub-agent returned %d chars", len(result))
            return result
        except Exception as e:
            logger.error("Sub-agent failed: %s", e, exc_info=True)
            return f"Sub-agent error: {e}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        task = args.get("task", "")
        return f"Handing a task to a sub-agent: {task[:100]}..."
