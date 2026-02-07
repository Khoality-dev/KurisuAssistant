"""Base agent class."""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncGenerator, Dict, List, Any, Optional, TYPE_CHECKING

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
    tools: List[str] = field(default_factory=list)
    think: bool = False


@dataclass
class AgentContext:
    """Context passed to agent during processing."""
    user_id: int = 0
    conversation_id: int = 0
    frame_id: int = 0
    model_name: str = ""
    handler: Optional["ChatSessionHandler"] = None
    available_agents: List[AgentConfig] = field(default_factory=list)


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

        if require_approval and tool and tool.requires_approval:
            # Create approval request
            approval_request = ToolApprovalRequestEvent(
                tool_name=tool_name,
                tool_args=tool_args,
                agent_id=self.config.id,
                agent_name=self.config.name,
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

        # Execute the tool
        if tool:
            try:
                return await tool.execute(tool_args)
            except Exception as e:
                logger.error(f"Tool execution failed: {e}", exc_info=True)
                return f"Tool execution failed: {e}"
        elif self.tool_registry.is_mcp_tool(tool_name):
            # Execute MCP tool via orchestrator
            return await self._execute_mcp_tool(tool_name, tool_args, context)
        else:
            return f"Unknown tool: {tool_name}"

    async def _execute_mcp_tool(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        context: AgentContext,
    ) -> str:
        """Execute an MCP tool.

        Args:
            tool_name: MCP tool name
            tool_args: Tool arguments
            context: Agent context

        Returns:
            Tool result
        """
        try:
            from mcp_tools.orchestrator import get_orchestrator
            orchestrator = get_orchestrator()

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
                return results[0].get("content", "")
            return "No result from MCP tool"

        except Exception as e:
            logger.error(f"MCP tool execution failed: {e}", exc_info=True)
            return f"MCP tool execution failed: {e}"

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

        - Filters out Administrator routing messages
        - Adds speaker name prefix to agent/tool messages
        - Prepends agent descriptions and own system prompt
        """
        from agents.administrator import ADMINISTRATOR_NAME

        # Build agent descriptions for context
        agent_descriptions = []
        for agent in context.available_agents:
            if agent.name == self.config.name:
                continue  # Skip self
            desc = agent.system_prompt[:150] if agent.system_prompt else "General assistant"
            agent_descriptions.append(f"- {agent.name}: {desc}")

        # Build system prompt with agent identity and context
        system_parts = []
        system_parts.append(f"You are {self.config.name}.")
        if self.config.system_prompt:
            system_parts.append(self.config.system_prompt)
        if agent_descriptions:
            system_parts.append(
                "Other agents in this conversation:\n" + "\n".join(agent_descriptions)
            )

        prepared = []
        if system_parts:
            prepared.append({"role": "system", "content": "\n\n".join(system_parts)})

        for msg in messages:
            role = msg.get("role", "user")
            agent_name = msg.get("agent_name", "")

            # Filter out Administrator messages (routing decisions)
            if agent_name == ADMINISTRATOR_NAME:
                continue

            content = msg.get("content", "")

            # Add speaker name prefix for non-system messages
            if role == "user":
                content = f"[User]: {content}"
            elif agent_name and role != "system":
                content = f"[{agent_name}]: {content}"

            # Map roles for Ollama compatibility
            chat_role = "user" if role == "user" else ("system" if role == "system" else "assistant")

            prepared.append({"role": chat_role, "content": content})

        return prepared

    async def process(
        self,
        messages: List[Dict],
        context: AgentContext,
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Process messages with LLM."""
        from llm import create_llm_provider

        llm = create_llm_provider("ollama")

        # Prepare messages: filter Administrator, add speaker names, inject agent descriptions
        messages = self._prepare_messages(messages, context)

        # Get tools for this agent
        tool_schemas = self.tool_registry.get_schemas(self.config.tools or None)

        # Determine model
        model = self.config.model_name or context.model_name

        # Stream from LLM
        try:
            stream = llm.chat(
                model=model,
                messages=messages,
                tools=tool_schemas if tool_schemas else [],
                stream=True,
                think=self.config.think,
            )

            async for chunk in async_iterate(stream):
                msg = chunk.message

                # Handle thinking
                thinking = getattr(msg, 'thinking', None)
                if thinking:
                    yield StreamChunkEvent(
                        content="",
                        thinking=thinking,
                        role="assistant",
                        agent_id=self.config.id,
                        agent_name=self.config.name,
                        conversation_id=context.conversation_id,
                        frame_id=context.frame_id,
                    )

                # Handle content
                if msg.content:
                    yield StreamChunkEvent(
                        content=msg.content,
                        role="assistant",
                        agent_id=self.config.id,
                        agent_name=self.config.name,
                        conversation_id=context.conversation_id,
                        frame_id=context.frame_id,
                    )

                # Handle tool calls
                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    for tool_call in msg.tool_calls:
                        import json
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)

                        # Execute tool with approval
                        result = await self.execute_tool(tool_name, tool_args, context)

                        # Yield tool result
                        yield StreamChunkEvent(
                            content=result,
                            role="tool",
                            agent_id=self.config.id,
                            agent_name=self.config.name,
                            conversation_id=context.conversation_id,
                            frame_id=context.frame_id,
                        )

        except Exception as e:
            logger.error(f"Agent processing failed: {e}", exc_info=True)
            yield StreamChunkEvent(
                content=f"Error: {e}",
                role="assistant",
                agent_id=self.config.id,
                agent_name=self.config.name,
                conversation_id=context.conversation_id,
                frame_id=context.frame_id,
            )
