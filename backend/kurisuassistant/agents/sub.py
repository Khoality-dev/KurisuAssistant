"""SubAgent — task-executor agent with no identity.

Called synchronously by a MainAgent via the SubAgentTool adapter. Runs
its own LLM + tool-loop internally, returns a single string back to the
caller. The user sees only the MainAgent's paraphrased output, never
the SubAgent's intermediate stream.
"""

import json
import logging
from typing import Any, Dict, List

from kurisuassistant.tools.base import BaseTool

from .base import BaseAgent, AgentContext, async_iterate, estimate_tokens

logger = logging.getLogger(__name__)


class SubAgent(BaseAgent):
    """Task-only agent. No identity, no streaming to the frontend."""

    async def execute(self, task: str, context: AgentContext) -> str:
        """Run the sub-agent on a single task and return the final assistant text.

        Builds a minimal message list (system prompt + memory + the task),
        runs the LLM tool-loop until completion, and accumulates the
        assistant content into a string. Does not yield events.
        """
        from kurisuassistant.models.llm import create_llm_provider

        model = self.config.model_name or context.model_name
        provider_type = self.config.provider_type or "ollama"

        api_key = None
        if provider_type == "gemini":
            api_key = context.gemini_api_key
        elif provider_type == "nvidia":
            api_key = context.nvidia_api_key

        llm = create_llm_provider(provider_type, api_url=context.api_url, api_key=api_key)

        system_parts: List[str] = []
        if self.config.system_prompt:
            system_parts.append(self.config.system_prompt)
        if self.config.memory_enabled and self.config.memory:
            system_parts.append("Your memory:\n" + self.config.memory)

        messages: List[Dict] = []
        if system_parts:
            messages.append({"role": "system", "content": "\n\n".join(system_parts)})
        messages.append({"role": "user", "content": task})

        allowed = set(self.config.available_tools) if self.config.available_tools is not None else None
        tool_schemas = self.tool_registry.get_schemas(allowed)

        # Server-side MCP tools
        if context.user_id:
            try:
                from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
                mcp_tools = await get_user_orchestrator(context.user_id).get_tools()
                if allowed is not None:
                    mcp_tools = [t for t in mcp_tools if t.get("function", {}).get("name") in allowed]
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
                    think=self.config.think,
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

                tool_denied = False
                for tc in all_tool_calls:
                    tool_name = tc.function.name
                    tool_args = tc.function.arguments
                    if isinstance(tool_args, str):
                        tool_args = json.loads(tool_args)

                    result = await self.execute_tool(tool_name, tool_args, context)
                    messages.append({"role": "tool", "content": result.content})
                    if result.status == "denied":
                        tool_denied = True
                        break

                if tool_denied:
                    final_content = full_content or "Sub-agent stopped: user denied a tool."
                    break

            else:
                final_content = full_content or "Sub-agent hit max tool rounds without final answer."

        except Exception as e:
            logger.error(f"SubAgent execution failed: {e}", exc_info=True)
            return f"Sub-agent error: {e}"

        return final_content or "Sub-agent returned empty response."


class SubAgentTool(BaseTool):
    """Thin adapter — exposes a SubAgent as a callable tool to a MainAgent's LLM."""

    built_in = False

    def __init__(self, sub: SubAgent):
        self.sub = sub
        self.name = self._to_tool_name(sub.config.name)
        self.description = sub.config.description or f"Delegate task to {sub.config.name}"

    @staticmethod
    def _to_tool_name(agent_name: str) -> str:
        """Convert an agent name to a valid tool name (snake_case)."""
        name = agent_name.lower()
        name = "".join(c if c.isalnum() else "_" for c in name)
        while "__" in name:
            name = name.replace("__", "_")
        return name.strip("_") + "_agent"

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": f"Delegate a task to {self.sub.config.name}. {self.description}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "The task or question to send to this sub-agent",
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

        logger.info(f"SubAgent '{self.sub.config.name}' executing task: {task[:100]}...")
        try:
            result = await self.sub.execute(task, context)
            logger.info(f"SubAgent '{self.sub.config.name}' returned {len(result)} chars")
            return result
        except Exception as e:
            logger.error(f"SubAgent '{self.sub.config.name}' failed: {e}", exc_info=True)
            return f"Sub-agent error: {e}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        task = args.get("task", "")
        return f"Asking {self.sub.config.name}: {task[:100]}..."
