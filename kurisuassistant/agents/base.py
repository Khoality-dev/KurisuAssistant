"""Base agent class."""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncGenerator, Callable, Coroutine, Dict, List, Any, Optional, TYPE_CHECKING

from kurisuassistant.websocket.events import (
    StreamChunkEvent,
    ToolApprovalRequestEvent,
    ToolApprovalResponseEvent,
    AgentSwitchEvent,
)
from kurisuassistant.tools import ToolRegistry

if TYPE_CHECKING:
    from kurisuassistant.websocket.handlers import ChatSessionHandler

logger = logging.getLogger(__name__)


_SENTINEL = object()


async def async_iterate(sync_iterator):
    """Convert a synchronous iterator to an async one using threads.

    This allows asyncio.CancelledError to be raised between iterations,
    making synchronous streams (like Ollama) cancellable.
    """
    it = iter(sync_iterator)
    while True:
        chunk = await asyncio.to_thread(next, it, _SENTINEL)
        if chunk is _SENTINEL:
            break
        yield chunk


@dataclass
class AgentConfig:
    """Configuration for an agent."""
    id: Optional[int] = None  # Database ID (None for router)
    name: str = ""  # Role name
    description: str = ""  # Short one-liner for routing
    system_prompt: str = ""  # Role instructions
    model_name: Optional[str] = None
    provider_type: str = "ollama"
    available_tools: Optional[List[str]] = None  # None = all tools, list = only these
    think: bool = False
    memory: Optional[str] = None
    memory_enabled: bool = True
    enabled: bool = True
    is_system: bool = False
    # Persona fields (resolved from persona at load time)
    persona_id: Optional[int] = None
    persona_name: str = ""  # Character name
    persona_system_prompt: str = ""  # Personality prompt
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    preferred_name: Optional[str] = None
    trigger_word: Optional[str] = None
    use_deferred_tools: bool = False  # Use 3 meta-tools instead of flat schemas


@dataclass
class AgentContext:
    """Context passed to agent during processing."""
    user_id: int = 0
    conversation_id: int = 0
    frame_id: int = 0
    model_name: str = ""
    handler: Optional["ChatSessionHandler"] = None
    available_agents: List[AgentConfig] = field(default_factory=list)
    user_system_prompt: str = ""
    preferred_name: str = ""
    api_url: Optional[str] = None  # User-specific Ollama endpoint
    gemini_api_key: Optional[str] = None  # User-specific Gemini API key
    nvidia_api_key: Optional[str] = None  # User-specific NVIDIA NIM API key
    client_tools: List[Dict] = field(default_factory=list)
    client_tool_callback: Optional[Callable[[str, Dict], Coroutine[Any, Any, str]]] = None
    images: Optional[List[str]] = None  # base64 images for current user message
    context_size: Optional[int] = None  # Ollama num_ctx override
    compacted_context: str = ""  # Rolling conversation summary (short-term memory)


@dataclass
class ToolResult:
    """Result from a tool execution, optionally including images."""
    content: str
    images: List[str] = field(default_factory=list)
    status: str = "success"  # "success" | "error" | "denied"

    @staticmethod
    def _detect_error(content: str) -> bool:
        """Check if tool content indicates an error."""
        import json as _json
        stripped = content.strip()
        # Detect JSON error responses: {"error": "..."}
        if stripped.startswith("{"):
            try:
                parsed = _json.loads(stripped)
                if isinstance(parsed, dict) and "error" in parsed:
                    return True
            except (_json.JSONDecodeError, ValueError):
                pass
        # Detect wrapped client/MCP tool errors
        if stripped.startswith("Client tool error:") or stripped.startswith("MCP client not available"):
            return True
        return False

    @staticmethod
    def from_content(content: str, **kwargs) -> "ToolResult":
        """Create a ToolResult, auto-detecting error status from content."""
        status = "error" if ToolResult._detect_error(content) else "success"
        return ToolResult(content=content, status=status, **kwargs)


class BaseAgent(ABC):
    """Base class for all agents."""

    def __init__(self, config: AgentConfig, tool_registry: ToolRegistry):
        self.config = config
        self.tool_registry = tool_registry

    @abstractmethod
    async def process(
        self,
        messages: List[Dict],
        context: AgentContext,
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Process messages and yield response chunks.

        Args:
            messages: Full conversation history
            context: Agent context with metadata

        Yields:
            StreamChunkEvent for each content chunk
        """
        pass

    async def execute_tool(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        context: AgentContext,
        require_approval: bool = True,
    ) -> ToolResult:
        """Execute a tool, optionally requesting approval first.

        Args:
            tool_name: Name of the tool to execute
            tool_args: Arguments for the tool
            context: Agent context
            require_approval: Whether to request user approval

        Returns:
            ToolResult with content and optional images
        """
        import json as _json

        # Deferred tools: intercept call_tool and delegate to the inner tool
        if tool_name == "call_tool":
            inner_name = tool_args.get("name", "")
            inner_args = tool_args.get("arguments", {})
            if isinstance(inner_args, str):
                inner_args = _json.loads(inner_args)
            return await self.execute_tool(inner_name, inner_args, context, require_approval)

        # Deferred tools: handle list_tools / search_tools / get_tool_schema via proxy
        proxy = getattr(self, "_deferred_proxy", None)
        if proxy and tool_name == "list_tools":
            page = tool_args.get("page", 1)
            content = await proxy.list_tools_page(page)
            return ToolResult(content=content)
        if proxy and tool_name == "search_tools":
            query = tool_args.get("query", "")
            content = await proxy.search_tools(query)
            return ToolResult(content=content)
        if proxy and tool_name == "get_tool_schema":
            name = tool_args.get("name", "")
            content = await proxy.get_tool_schema(name)
            return ToolResult(content=content)

        tool = self.tool_registry.get(tool_name)

        # Enforce tool access: built-in tools always available,
        # available_tools allowlist restricts non-built-in tools
        if self.config.available_tools is not None and tool_name not in self.config.available_tools:
            if not (tool and tool.built_in):
                logger.warning(f"Agent '{self.config.name}' tried to use unavailable tool: {tool_name}")
                return ToolResult(content=f"Tool not available: {tool_name}", status="error")

        if require_approval and tool and tool.requires_approval:
            # Create approval request
            approval_request = ToolApprovalRequestEvent(
                tool_name=tool_name,
                tool_args=tool_args,
                agent_id=self.config.id,
                name=self.config.name,
                description=tool.describe_call(tool_args),
                risk_level=tool.risk_level,
            )

            # Request approval from handler
            if context.handler:
                response = await context.handler.request_tool_approval(approval_request)

                if not response.approved:
                    return ToolResult(content=f"Tool execution denied by user: {tool_name}", status="denied")

                # Use modified args if provided
                if response.modified_args:
                    tool_args = response.modified_args

        # Copy args before injecting internal keys to avoid mutating the
        # caller's dict (which may be referenced by tool_calls in messages
        # sent back to the LLM).
        exec_args = dict(tool_args)

        # Inject conversation_id for context-aware tools
        if context.conversation_id:
            exec_args["conversation_id"] = context.conversation_id

        # Inject user_id for user-scoped tools (e.g. skill lookup)
        if context.user_id:
            exec_args["user_id"] = context.user_id

        # Inject agent_id for agent-scoped tools (e.g. knowledge graph)
        exec_args["agent_id"] = self.config.id

        # Inject handler for tools that need WebSocket access (e.g. media player)
        if context.handler:
            exec_args["_handler"] = context.handler

        # Execute the tool
        if tool:
            try:
                result = await tool.execute(exec_args)
                return ToolResult.from_content(result)
            except Exception as e:
                logger.error(f"Tool execution failed: {e}", exc_info=True)
                return ToolResult(content=f"Tool execution failed: {e}", status="error")
        elif context.user_id:
            # Try server-side MCP tool first, then client-side tool
            return await self._execute_mcp_tool(tool_name, tool_args, context)
        else:
            return ToolResult(content=f"Unknown tool: {tool_name}", status="error")

    async def _execute_mcp_tool(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        context: AgentContext,
    ) -> ToolResult:
        """Execute an MCP tool (server-side), falling back to client-side tools.

        Args:
            tool_name: MCP tool name
            tool_args: Tool arguments
            context: Agent context

        Returns:
            ToolResult with content and optional images
        """
        try:
            from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
            orchestrator = get_user_orchestrator(context.user_id)

            # Ensure tool-to-client mapping is loaded (uses cache if fresh)
            await orchestrator.get_tools()

            # Don't inject internal context (user_id, agent_id, etc.) into
            # external MCP tool args — external servers don't expect them.
            mcp_args = dict(tool_args)

            # Create a mock tool call object
            class MockToolCall:
                class Function:
                    def __init__(self, name, args):
                        self.name = name
                        self.arguments = args

                def __init__(self, name, args):
                    self.function = self.Function(name, args)

            mock_call = MockToolCall(tool_name, mcp_args)
            results = await orchestrator.execute_tool_calls(
                [mock_call],
                conversation_id=context.conversation_id
            )

            if results:
                content = results[0].get("content", "")
                if content != "MCP client not available":
                    images = results[0].get("images") or []
                    return ToolResult.from_content(content, images=images)

        except Exception as e:
            logger.warning(f"Server MCP tool execution failed for '{tool_name}': {e}")

        # Fall back to client-side tool
        if context.client_tool_callback and tool_name in {
            t.get("function", {}).get("name", "") for t in context.client_tools
        }:
            try:
                result = await context.client_tool_callback(tool_name, tool_args)
                return ToolResult.from_content(result)
            except Exception as e:
                logger.error(f"Client tool execution failed: {e}", exc_info=True)
                return ToolResult(content=f"Client tool execution failed: {e}", status="error")

        return ToolResult(content=f"Unknown tool: {tool_name}", status="error")

    async def delegate_to(
        self,
        agent_config: AgentConfig,
        messages: List[Dict],
        context: AgentContext,
        reason: str = "",
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Delegate to another agent.

        Args:
            agent_config: Configuration for the sub-agent
            messages: Messages to pass to sub-agent
            context: Agent context
            reason: Reason for delegation

        Yields:
            StreamChunkEvent from sub-agent
        """
        # Notify client of agent switch
        if context.handler:
            switch_event = AgentSwitchEvent(
                from_agent_id=self.config.id,
                from_agent_name=self.config.name,
                to_agent_id=agent_config.id,
                to_agent_name=agent_config.name,
                reason=reason,
            )
            await context.handler.send_event(switch_event)

        # Create sub-agent and run it
        sub_agent = BaseAgent.create_from_config(agent_config, self.tool_registry)

        async for chunk in sub_agent.process(messages, context):
            yield chunk

    @staticmethod
    def create_from_config(config: AgentConfig, tool_registry: ToolRegistry) -> "BaseAgent":
        """Create an agent from config.

        Args:
            config: Agent configuration
            tool_registry: Tool registry

        Returns:
            Agent instance
        """
        # Import here to avoid circular import
        from .router import RouterAgent

        # For now, all user-created agents use the same base implementation
        # The router is special and has delegation logic
        if config.name == "router" or config.id is None:
            return RouterAgent(config, tool_registry)
        else:
            return SimpleAgent(config, tool_registry)


class SimpleAgent(BaseAgent):
    """Simple agent that just processes with LLM - no delegation."""

    def _prepare_messages(
        self,
        messages: List[Dict],
        context: AgentContext,
    ) -> List[Dict]:
        """Prepare messages for LLM by filtering and enriching.

        - Builds a unified system prompt with agent persona + user preferences
        - Filters out system messages from conversation history (already incorporated)
        - Filters out Administrator routing messages
        - Adds speaker name prefix to agent/tool messages
        """
        import datetime

        # Build agent descriptions for context
        agent_descriptions = []
        for agent in context.available_agents:
            if agent.name == self.config.name:
                continue  # Skip self
            desc = agent.system_prompt[:150] if agent.system_prompt else "General assistant"
            agent_descriptions.append(f"- {agent.name}: {desc}")

        # Build unified system prompt: agent persona + user preferences
        system_parts = []
        system_parts.append(f"You are {self.config.persona_name or self.config.name}.")
        if self.config.system_prompt:
            system_parts.append(self.config.system_prompt)
        if self.config.persona_system_prompt:
            system_parts.append(self.config.persona_system_prompt)
        if context.user_system_prompt:
            system_parts.append(context.user_system_prompt)
        # Agent-level preferred_name takes priority over user-level
        preferred_name = self.config.preferred_name or context.preferred_name
        if preferred_name:
            system_parts.append(f"The user prefers to be called: {preferred_name}")
        system_parts.append(f"Current time: {datetime.datetime.utcnow().isoformat()}")

        # List available skills (agents fetch full instructions on-demand via tool)
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
        # Deferred tools: guide the LLM on the meta-tool workflow
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

        # Inject agent memory (long-term)
        if self.config.memory_enabled and self.config.memory:
            system_parts.append("Your memory:\n" + self.config.memory)

        # Inject compacted conversation context (short-term rolling summary)
        if context.compacted_context:
            system_parts.append("Conversation context:\n" + context.compacted_context)

        if agent_descriptions:
            system_parts.append(
                "Other agents in this conversation:\n"
                + "\n".join(agent_descriptions)
                + "\n\nYou may see messages from these agents. "
                "Just focus on your own response — "
                "do not direct others to speak, ask them to chime in, "
                "or manage the conversation flow. A separate system handles turn-taking."
            )

        prepared = []
        prepared.append({"role": "system", "content": "\n\n".join(system_parts)})

        for msg in messages:
            role = msg.get("role", "user")

            # Skip system messages — already incorporated into agent's system prompt
            if role == "system":
                continue

            content = msg.get("content", "")

            # Preserve natural turn structure: user/assistant/tool keep their roles
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
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Process messages with LLM, looping on tool calls.

        Flow: LLM call → stream response → if tool_calls, execute tools,
        append results to messages, and call LLM again (up to 10 rounds).
        """
        import json
        from kurisuassistant.models.llm import create_llm_provider

        # Determine model and provider
        model = self.config.model_name or context.model_name
        provider_type = self.config.provider_type or "ollama"

        # Select API key based on provider
        api_key = None
        if provider_type == "gemini":
            api_key = context.gemini_api_key
        elif provider_type == "nvidia":
            api_key = context.nvidia_api_key

        llm = create_llm_provider(
            provider_type,
            api_url=context.api_url,
            api_key=api_key,
        )

        # Prepare messages: filter Administrator, add speaker names, inject agent descriptions
        messages = self._prepare_messages(messages, context)

        # Expose prepared messages for raw_input logging
        self.last_prepared_messages = messages

        # Build tool schemas — deferred (meta-tools) or flat (all schemas)
        allowed = set(self.config.available_tools) if self.config.available_tools is not None else None

        if self.config.use_deferred_tools:
            from kurisuassistant.tools.deferred import create_deferred_tools
            proxy, meta_tools = create_deferred_tools(
                tool_registry=self.tool_registry,
                available_tools=allowed,
                user_id=context.user_id,
                client_tools=context.client_tools or [],
            )
            self._deferred_proxy = proxy
            tool_schemas = [mt.get_schema() for mt in meta_tools]
        else:
            self._deferred_proxy = None
            tool_schemas = self.tool_registry.get_schemas(allowed)

            # Add user's server-side MCP tools (filtered by allowlist)
            if context.user_id:
                try:
                    from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
                    mcp_tools = await get_user_orchestrator(context.user_id).get_tools()
                    if allowed is not None:
                        mcp_tools = [t for t in mcp_tools if t.get("function", {}).get("name") in allowed]
                    tool_schemas.extend(mcp_tools)
                except Exception as e:
                    logger.warning(f"Failed to load MCP tools for user {context.user_id}: {e}")

            # Add client-side tools (filtered by allowlist)
            if context.client_tools:
                client_tools = context.client_tools
                if allowed is not None:
                    client_tools = [t for t in client_tools if t.get("function", {}).get("name") in allowed]
                tool_schemas.extend(client_tools)

        # Attach base64 images to the last user message for vision models
        if context.images:
            for msg in reversed(messages):
                if msg.get("role") == "user":
                    msg["images"] = context.images
                    break

        # Deferred tools need extra rounds for discovery (list → schema → call)
        MAX_TOOL_ROUNDS = 25 if self.config.use_deferred_tools else 10

        try:
            for _round in range(MAX_TOOL_ROUNDS):
                # Update raw input snapshot before each LLM call
                self.last_prepared_messages = [dict(m) for m in messages]

                stream = llm.chat(
                    model=model,
                    messages=messages,
                    tools=tool_schemas if tool_schemas else [],
                    stream=True,
                    think=self.config.think,
                    options={"num_ctx": context.context_size or 8192},
                )

                # Accumulate full response to detect tool calls and build follow-up messages
                full_content = ""
                full_thinking = ""
                all_tool_calls = []

                async for chunk in async_iterate(stream):
                    msg = chunk.message

                    # Handle thinking
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
                            frame_id=context.frame_id,
                            model_name=model,
                            provider_type=self.config.provider_type,
                        )

                    # Handle content
                    if msg.content:
                        full_content += msg.content
                        yield StreamChunkEvent(
                            content=msg.content,
                            role="assistant",
                            agent_id=self.config.id,
                            name=self.config.name,
                            conversation_id=context.conversation_id,
                            frame_id=context.frame_id,
                            model_name=model,
                            provider_type=self.config.provider_type,
                        )

                    # Collect tool calls (typically arrive in final chunk(s))
                    if hasattr(msg, 'tool_calls') and msg.tool_calls:
                        all_tool_calls.extend(msg.tool_calls)

                # No tool calls — LLM gave a final answer, done
                if not all_tool_calls:
                    break

                # Append assistant message (with tool_calls) so Ollama sees the call context
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

                # Execute each tool and feed results back
                tool_denied = False
                for tc in all_tool_calls:
                    tool_name = tc.function.name
                    tool_args = tc.function.arguments
                    if isinstance(tool_args, str):
                        tool_args = json.loads(tool_args)

                    result = await self.execute_tool(tool_name, tool_args, context)

                    # For deferred call_tool, show the inner tool name to the client
                    display_name = tool_name
                    display_args = tool_args
                    if tool_name == "call_tool":
                        display_name = tool_args.get("name", "call_tool")
                        display_args = tool_args.get("arguments", {})

                    # Yield tool result (name=tool, no agent_id — tools aren't agents)
                    yield StreamChunkEvent(
                        content=result.content,
                        role="tool",
                        agent_id=None,
                        name=display_name,
                        conversation_id=context.conversation_id,
                        frame_id=context.frame_id,
                        tool_args=display_args,
                        tool_status=result.status,
                        images=result.images or None,
                    )

                    # Append tool result for next LLM round
                    messages.append({"role": "tool", "content": result.content})

                    # If tool was denied, stop executing remaining tools
                    if result.status == "denied":
                        tool_denied = True
                        break

                    # If route_to was called, stop immediately — don't loop back to LLM
                    if tool_name == "route_to":
                        tool_denied = True  # Reuse flag to break outer loop
                        break

                # If user denied a tool or route_to was called, stop the agent's tool loop
                if tool_denied:
                    break

                # Loop continues — LLM will see tool results and can call more tools or answer

        except Exception as e:
            logger.error(f"Agent processing failed: {e}", exc_info=True)
            yield StreamChunkEvent(
                content=f"Error: {e}",
                role="assistant",
                agent_id=self.config.id,
                name=self.config.name,
                conversation_id=context.conversation_id,
                frame_id=context.frame_id,
            )
