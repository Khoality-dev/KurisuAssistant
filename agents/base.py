"""Base agent class."""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncGenerator, Callable, Coroutine, Dict, List, Any, Optional, TYPE_CHECKING

from websocket.events import (
    StreamChunkEvent,
    ToolApprovalRequestEvent,
    ToolApprovalResponseEvent,
    AgentSwitchEvent,
)
from tools import ToolRegistry

if TYPE_CHECKING:
    from websocket.handlers import ChatSessionHandler

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
    name: str = ""
    system_prompt: str = ""
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    model_name: Optional[str] = None
    excluded_tools: Optional[List[str]] = None
    think: bool = False
    memory: Optional[str] = None
    memory_enabled: bool = True


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
    client_tools: List[Dict] = field(default_factory=list)
    client_tool_callback: Optional[Callable[[str, Dict], Coroutine[Any, Any, str]]] = None


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
    ) -> str:
        """Execute a tool, optionally requesting approval first.

        Args:
            tool_name: Name of the tool to execute
            tool_args: Arguments for the tool
            context: Agent context
            require_approval: Whether to request user approval

        Returns:
            Tool execution result
        """
        tool = self.tool_registry.get(tool_name)

        # Enforce tool access: built-in tools always available,
        # excluded_tools blocks specific non-built-in tools
        if self.config.excluded_tools and tool_name in self.config.excluded_tools:
            if not (tool and tool.built_in):
                logger.warning(f"Agent '{self.config.name}' tried to use excluded tool: {tool_name}")
                return f"Tool not available: {tool_name}"

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
                    return f"Tool execution denied by user: {tool_name}"

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

        # Inject handler for tools that need WebSocket access (e.g. media player)
        if context.handler:
            exec_args["_handler"] = context.handler

        # Execute the tool
        if tool:
            try:
                return await tool.execute(exec_args)
            except Exception as e:
                logger.error(f"Tool execution failed: {e}", exc_info=True)
                return f"Tool execution failed: {e}"
        elif context.user_id:
            # Try server-side MCP tool first, then client-side tool
            return await self._execute_mcp_tool(tool_name, tool_args, context)
        else:
            return f"Unknown tool: {tool_name}"

    async def _execute_mcp_tool(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        context: AgentContext,
    ) -> str:
        """Execute an MCP tool (server-side), falling back to client-side tools.

        Args:
            tool_name: MCP tool name
            tool_args: Tool arguments
            context: Agent context

        Returns:
            Tool result
        """
        try:
            from mcp_tools.orchestrator import get_user_orchestrator
            orchestrator = get_user_orchestrator(context.user_id)

            # Create a mock tool call object
            class MockToolCall:
                class Function:
                    def __init__(self, name, args):
                        self.name = name
                        self.arguments = args

                def __init__(self, name, args):
                    self.function = self.Function(name, args)

            mock_call = MockToolCall(tool_name, tool_args)
            results = await orchestrator.execute_tool_calls(
                [mock_call],
                conversation_id=context.conversation_id
            )

            if results:
                content = results[0].get("content", "")
                if content != "MCP client not available":
                    return content

        except Exception as e:
            logger.warning(f"Server MCP tool execution failed for '{tool_name}': {e}")

        # Fall back to client-side tool
        if context.client_tool_callback and tool_name in {
            t.get("function", {}).get("name", "") for t in context.client_tools
        }:
            try:
                return await context.client_tool_callback(tool_name, tool_args)
            except Exception as e:
                logger.error(f"Client tool execution failed: {e}", exc_info=True)
                return f"Client tool execution failed: {e}"

        return f"Unknown tool: {tool_name}"

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
        from agents.administrator import ADMINISTRATOR_NAME

        # Build agent descriptions for context
        agent_descriptions = []
        for agent in context.available_agents:
            if agent.name == self.config.name:
                continue  # Skip self
            desc = agent.system_prompt[:150] if agent.system_prompt else "General assistant"
            agent_descriptions.append(f"- {agent.name}: {desc}")

        # Build unified system prompt: agent persona + user preferences
        system_parts = []
        system_parts.append(f"You are {self.config.name}.")
        if self.config.system_prompt:
            system_parts.append(self.config.system_prompt)
        if context.user_system_prompt:
            system_parts.append(context.user_system_prompt)
        if context.preferred_name:
            system_parts.append(f"The user prefers to be called: {context.preferred_name}")
        system_parts.append(f"Current time: {datetime.datetime.utcnow().isoformat()}")

        # List available skills (agents fetch full instructions on-demand via tool)
        if context.user_id:
            from tools.skills import get_skill_names_for_user
            skill_names = get_skill_names_for_user(context.user_id)
            if skill_names:
                system_parts.append(
                    "You have skills available: " + ", ".join(skill_names) + ".\n"
                    "IMPORTANT: Before performing any task, check if a relevant skill is available. "
                    "If so, call get_skill_instructions to read the skill's full instructions first, then follow them."
                )
        # Inject agent memory
        if self.config.memory_enabled and self.config.memory:
            system_parts.append("Your memory:\n" + self.config.memory)

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

        # Track last assistant speaker to determine tool result ownership.
        # Tool results always follow the assistant message that triggered them.
        last_assistant = None

        for msg in messages:
            role = msg.get("role", "user")
            speaker = msg.get("name", "")

            # Skip system messages — already incorporated into agent's system prompt
            if role == "system":
                continue

            # Track which agent last spoke
            if role == "assistant":
                last_assistant = speaker

            # Filter Administrator: assistant msgs by name, tool msgs by ownership
            if role == "assistant" and speaker == ADMINISTRATOR_NAME:
                continue
            if role == "tool" and last_assistant == ADMINISTRATOR_NAME:
                continue

            content = msg.get("content", "")

            # Ollama roles:
            #   "assistant" = this agent's own messages
            #   "tool"      = tool results from this agent's tool calls
            #   "user"      = everyone else (user, other agents, their tool results)
            if role == "assistant" and speaker == self.config.name:
                chat_role = "assistant"
            elif role == "tool" and last_assistant == self.config.name:
                chat_role = "tool"
            else:
                chat_role = "user"
                if role == "user":
                    content = f"[User]: {content}"
                elif speaker:
                    content = f"[{speaker}]: {content}"

            prepared.append({"role": chat_role, "content": content})

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
        from models.llm import create_llm_provider

        llm = create_llm_provider("ollama")

        # Prepare messages: filter Administrator, add speaker names, inject agent descriptions
        messages = self._prepare_messages(messages, context)

        # Expose prepared messages for raw_input logging
        self.last_prepared_messages = messages

        # Get tools for this agent (all tools minus excluded)
        tool_schemas = self.tool_registry.get_schemas(self.config.excluded_tools)

        # Add user's server-side MCP tools (filtered by agent's exclusion list)
        if context.user_id:
            try:
                from mcp_tools.orchestrator import get_user_orchestrator
                mcp_tools = await get_user_orchestrator(context.user_id).get_tools()
                if self.config.excluded_tools:
                    excluded = set(self.config.excluded_tools)
                    mcp_tools = [t for t in mcp_tools if t.get("function", {}).get("name") not in excluded]
                tool_schemas.extend(mcp_tools)
            except Exception as e:
                logger.warning(f"Failed to load MCP tools for user {context.user_id}: {e}")

        # Add client-side tools (filtered by agent's exclusion list)
        if context.client_tools:
            client_tools = context.client_tools
            if self.config.excluded_tools:
                excluded = set(self.config.excluded_tools)
                client_tools = [t for t in client_tools if t.get("function", {}).get("name") not in excluded]
            tool_schemas.extend(client_tools)

        # Determine model
        model = self.config.model_name or context.model_name

        MAX_TOOL_ROUNDS = 10

        try:
            for _round in range(MAX_TOOL_ROUNDS):
                stream = llm.chat(
                    model=model,
                    messages=messages,
                    tools=tool_schemas if tool_schemas else [],
                    stream=True,
                    think=self.config.think,
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
                        )

                    # Collect tool calls (typically arrive in final chunk(s))
                    if hasattr(msg, 'tool_calls') and msg.tool_calls:
                        all_tool_calls.extend(msg.tool_calls)

                # No tool calls — LLM gave a final answer, done
                if not all_tool_calls:
                    break

                # Append assistant message (with tool_calls) so Ollama sees the call context
                assistant_msg = {"role": "assistant", "content": full_content}
                tc_list = []
                for tc in all_tool_calls:
                    args = tc.function.arguments
                    if isinstance(args, str):
                        args = json.loads(args)
                    tc_list.append({"function": {"name": tc.function.name, "arguments": args}})
                assistant_msg["tool_calls"] = tc_list
                messages.append(assistant_msg)

                # Execute each tool and feed results back
                for tc in all_tool_calls:
                    tool_name = tc.function.name
                    tool_args = tc.function.arguments
                    if isinstance(tool_args, str):
                        tool_args = json.loads(tool_args)

                    result = await self.execute_tool(tool_name, tool_args, context)

                    # Yield tool result (name=tool, no agent_id — tools aren't agents)
                    yield StreamChunkEvent(
                        content=result,
                        role="tool",
                        agent_id=None,
                        name=tool_name,
                        conversation_id=context.conversation_id,
                        frame_id=context.frame_id,
                        tool_args=tool_args,
                    )

                    # Append tool result for next LLM round
                    messages.append({"role": "tool", "content": result})

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
