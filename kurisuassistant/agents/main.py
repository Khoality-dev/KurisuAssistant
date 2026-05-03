"""MainAgent — interactive agent with identity that streams to the user.

Owns the persona (voice, avatar, character config, preferred_name,
trigger_word) and runs the LLM tool-loop. Emits StreamChunkEvents for
the user.
"""

import json
import logging
from typing import AsyncGenerator, Dict, List

from kurisuassistant.websocket.events import StreamChunkEvent

from .base import BaseAgent, AgentContext, async_iterate

logger = logging.getLogger(__name__)


class MainAgent(BaseAgent):
    """Conversational agent with identity. Streams to the user via StreamChunkEvent.

    - Identity + memory + skills + compacted context are folded into the
      system prompt by ``_prepare_messages``.
    - ``extra_tools`` is a handler-injected list (SubAgentTool adapters,
      etc.) mixed into the tool schemas presented to the LLM.
    - ``process`` yields StreamChunkEvent for every content/thinking/tool
      chunk produced during the LLM loop.
    """

    def __init__(self, config, tool_registry):
        super().__init__(config, tool_registry)
        self.turn_data: List[Dict] = []

    def _prepare_messages(
        self,
        messages: List[Dict],
        context: AgentContext,
    ) -> List[Dict]:
        """Prepare messages for LLM: build the system prompt."""
        import datetime

        # Build dynamic sub-agent delegation guide from injected SubAgentTool
        # adapters. The set of sub-agents is per-user and runtime-mutable, so
        # it must be assembled here rather than baked into stored prompts.
        from .sub import SubAgentTool
        sub_agent_lines = []
        if hasattr(self, "extra_tools") and self.extra_tools:
            for extra_tool in self.extra_tools:
                if not isinstance(extra_tool, SubAgentTool):
                    continue
                sub_cfg = extra_tool.sub.config
                desc = sub_cfg.description or (
                    (sub_cfg.system_prompt or "")[:150] if sub_cfg.system_prompt else ""
                )
                desc = desc.strip() or "specialized worker"
                sub_agent_lines.append(f"- `{extra_tool.name}` — {sub_cfg.name}: {desc}")

        system_parts = []

        base_prompt = f"You are {self.config.name}."
        if self.config.system_prompt:
            base_prompt += "\n\n" + self.config.system_prompt
        if context.user_system_prompt:
            base_prompt += "\n\n" + context.user_system_prompt
        preferred_name = self.config.preferred_name or context.preferred_name
        if preferred_name:
            base_prompt += f"\n\nThe user prefers to be called: {preferred_name}"
        base_prompt += f"\n\nCurrent time: {datetime.datetime.utcnow().isoformat()}"
        system_parts.append(base_prompt)

        if context.user_id:
            from kurisuassistant.tools.skills import get_skill_names_for_user
            skill_names = get_skill_names_for_user(context.user_id)
            if skill_names:
                system_parts.append(
                    "## Skills\n"
                    "You have the following skills: " + ", ".join(skill_names) + ".\n"
                    "Skills contain detailed instructions on HOW to perform specific tasks. "
                    "You MUST call get_skill_instructions to load the relevant skill's instructions BEFORE "
                    "attempting any task that matches a skill name. Do NOT guess or improvise — "
                    "always read the skill first and follow its instructions exactly."
                )

        if self.config.use_deferred_tools:
            system_parts.append(
                "## Tool Usage\n"
                "You have access to tools through a discovery system. Use these functions:\n"
                "1. list_tools(page?) — Browse available tools (name + description, paginated)\n"
                "2. search_tools(query) — Search tools by keyword in name or description\n"
                "3. get_tool_schema(name) — Get a tool's full parameter schema before calling it\n"
                "4. call_tool(name, arguments) — Execute a tool\n\n"
                "Workflow: list_tools or search_tools → get_tool_schema → call_tool.\n"
                "You may skip discovery if you already know the tool name from context or a previous turn."
            )

        if self.config.memory_enabled and self.config.memory:
            system_parts.append("Your memory:\n" + self.config.memory)

        if context.compacted_context:
            system_parts.append("Conversation context:\n" + context.compacted_context)

        if sub_agent_lines:
            system_parts.append(
                "## Available Sub-Agents\n"
                "You can delegate specialized tasks by calling these sub-agent tools:\n"
                + "\n".join(sub_agent_lines)
                + "\n\nDelegate when a sub-agent is clearly suited to the task; "
                "otherwise handle it yourself."
            )

        prepared = [{"role": "system", "content": "\n\n".join(system_parts)}]

        for msg in messages:
            role = msg.get("role", "user")
            if role == "system":
                continue  # already incorporated

            content = msg.get("content", "")
            if role == "assistant":
                chat_role = "assistant"
            elif role == "tool":
                chat_role = "tool"
            else:
                chat_role = "user"

            entry = {"role": chat_role, "content": content}
            if chat_role == "assistant" and "thinking" in msg:
                entry["thinking"] = msg["thinking"]
            prepared.append(entry)

        return prepared

    async def process(
        self,
        messages: List[Dict],
        context: AgentContext,
    ) -> AsyncGenerator:
        """Stream an LLM conversation, looping on tool calls.

        Yields StreamChunkEvent for every content/thinking chunk and tool result.
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

        messages = self._prepare_messages(messages, context)
        self.last_prepared_messages = messages

        allowed = set(self.config.available_tools) if self.config.available_tools is not None else None

        if self.config.use_deferred_tools:
            from kurisuassistant.tools.deferred import create_deferred_tools, META_TOOL_NAMES
            proxy, meta_tools = create_deferred_tools(
                tool_registry=self.tool_registry,
                available_tools=allowed,
                user_id=context.user_id,
                client_tools=context.client_tools or [],
            )
            self._deferred_proxy = proxy
            tool_schemas = [mt.get_schema() for mt in meta_tools]
            for tool in self.tool_registry._tools.values():
                if tool.built_in and tool.name not in META_TOOL_NAMES:
                    tool_schemas.append(tool.get_schema())
        else:
            self._deferred_proxy = None
            tool_schemas = self.tool_registry.get_schemas(allowed)

            if context.user_id:
                try:
                    from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
                    mcp_tools = await get_user_orchestrator(context.user_id).get_tools()
                    if allowed is not None:
                        mcp_tools = [t for t in mcp_tools if t.get("function", {}).get("name") in allowed]
                    tool_schemas.extend(mcp_tools)
                except Exception as e:
                    logger.warning(f"Failed to load MCP tools for user {context.user_id}: {e}")

            if context.client_tools:
                client_tools = context.client_tools
                if allowed is not None:
                    client_tools = [t for t in client_tools if t.get("function", {}).get("name") in allowed]
                tool_schemas.extend(client_tools)

        # Handler-injected tools (SubAgentTool adapters)
        if hasattr(self, 'extra_tools') and self.extra_tools:
            for extra_tool in self.extra_tools:
                tool_schemas.append(extra_tool.get_schema())

        if context.images:
            for msg in reversed(messages):
                if msg.get("role") == "user":
                    msg["images"] = context.images
                    break

        MAX_TOOL_ROUNDS = 25 if self.config.use_deferred_tools else 10
        self.turn_data = []

        try:
            for turn in range(MAX_TOOL_ROUNDS):
                raw_input_messages = [dict(m) for m in messages]
                self.last_prepared_messages = raw_input_messages

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
                        yield StreamChunkEvent(
                            content="",
                            thinking=thinking,
                            role="assistant",
                            agent_id=self.config.id,
                            name=self.config.name,
                            conversation_id=context.conversation_id,
                            model_name=model,
                            provider_type=self.config.provider_type,
                        )

                    if msg.content:
                        full_content += msg.content
                        yield StreamChunkEvent(
                            content=msg.content,
                            role="assistant",
                            agent_id=self.config.id,
                            name=self.config.name,
                            conversation_id=context.conversation_id,
                            model_name=model,
                            provider_type=self.config.provider_type,
                        )

                    if hasattr(msg, 'tool_calls') and msg.tool_calls:
                        all_tool_calls.extend(msg.tool_calls)

                if not all_tool_calls:
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

                    display_name = tool_name
                    display_args = tool_args
                    if tool_name == "call_tool":
                        display_name = tool_args.get("name", "call_tool")
                        display_args = tool_args.get("arguments", {})

                    yield StreamChunkEvent(
                        content=result.content,
                        role="tool",
                        agent_id=None,
                        name=display_name,
                        conversation_id=context.conversation_id,
                        tool_args=display_args,
                        tool_status=result.status,
                        images=result.images or None,
                    )

                    messages.append({"role": "tool", "content": result.content})

                    if result.status == "denied":
                        tool_denied = True
                        break

                if tool_denied:
                    break

        except Exception:
            # Re-raise so the WebSocket handler emits an ErrorEvent (transient,
            # toast-only) instead of yielding an assistant chunk that
            # `_stream_and_save_agent` would persist as a normal message and
            # later replay into the LLM context.
            logger.error("MainAgent processing failed", exc_info=True)
            raise
