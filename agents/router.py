"""Router agent - main orchestrator that can delegate to sub-agents."""

import json
import logging
from typing import AsyncGenerator, Dict, List, Optional

from .base import BaseAgent, AgentConfig, AgentContext, SimpleAgent, async_iterate
from websocket.events import StreamChunkEvent
from tools import ToolRegistry
from db.session import get_session
from db.repositories import AgentRepository

logger = logging.getLogger(__name__)


class RouterAgent(BaseAgent):
    """Main router agent that orchestrates sub-agents.

    The router can:
    1. Process messages directly
    2. Delegate to user-created sub-agents
    3. Use tools with approval
    """

    def __init__(self, config: AgentConfig, tool_registry: ToolRegistry):
        super().__init__(config, tool_registry)
        self._delegation_tools = self._build_delegation_tools()

    def _build_delegation_tools(self) -> List[Dict]:
        """Build delegation tool schemas based on available agents."""
        # This will be populated dynamically based on user's agents
        return []

    def _get_user_agents(self, user_id: int) -> List[AgentConfig]:
        """Load user's agents from database.

        Args:
            user_id: User ID

        Returns:
            List of agent configs
        """
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agents = agent_repo.list_by_user(user_id)

            return [
                AgentConfig(
                    id=agent.id,
                    name=agent.name,
                    system_prompt=agent.system_prompt or "",
                    voice_reference=agent.voice_reference,
                    avatar_uuid=agent.avatar_uuid,
                    model_name=agent.model_name,
                    tools=agent.tools or [],
                    think=agent.think,
                )
                for agent in agents
            ]

    def _build_delegation_tools_for_user(self, user_id: int) -> List[Dict]:
        """Build delegation tools based on user's agents.

        Args:
            user_id: User ID

        Returns:
            List of tool schemas for delegation
        """
        agents = self._get_user_agents(user_id)
        tools = []

        for agent in agents:
            tool = {
                "type": "function",
                "function": {
                    "name": f"delegate_to_{agent.id}",
                    "description": f"Delegate task to {agent.name}. {agent.system_prompt[:100] if agent.system_prompt else ''}",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "task": {
                                "type": "string",
                                "description": "The task to delegate"
                            },
                            "context": {
                                "type": "string",
                                "description": "Additional context for the agent"
                            }
                        },
                        "required": ["task"]
                    }
                }
            }
            tools.append(tool)

        return tools

    async def process(
        self,
        messages: List[Dict],
        context: AgentContext,
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Process messages, potentially delegating to sub-agents."""
        from llm import create_llm_provider

        llm = create_llm_provider("ollama")

        # Build tools: regular tools + delegation tools
        delegation_tools = self._build_delegation_tools_for_user(context.user_id)
        regular_tools = self.tool_registry.get_schemas()
        all_tools = delegation_tools + regular_tools

        # Add router system prompt if any
        if self.config.system_prompt:
            router_system = {"role": "system", "content": self.config.system_prompt}
            messages = [router_system] + messages

        model = context.model_name

        try:
            stream = llm.chat(
                model=model,
                messages=messages,
                tools=all_tools if all_tools else [],
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
                        agent_name=self.config.name or "router",
                        conversation_id=context.conversation_id,
                        frame_id=context.frame_id,
                    )

                # Handle content
                if msg.content:
                    yield StreamChunkEvent(
                        content=msg.content,
                        role="assistant",
                        agent_id=self.config.id,
                        agent_name=self.config.name or "router",
                        conversation_id=context.conversation_id,
                        frame_id=context.frame_id,
                    )

                # Handle tool calls
                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    for tool_call in msg.tool_calls:
                        tool_name = tool_call.function.name
                        tool_args = json.loads(tool_call.function.arguments)

                        # Check if it's a delegation
                        if tool_name.startswith("delegate_to_"):
                            agent_id = int(tool_name.replace("delegate_to_", ""))
                            async for sub_chunk in self._handle_delegation(
                                agent_id,
                                tool_args,
                                messages,
                                context,
                            ):
                                yield sub_chunk
                        else:
                            # Regular tool execution with approval
                            result = await self.execute_tool(tool_name, tool_args, context)

                            yield StreamChunkEvent(
                                content=result,
                                role="tool",
                                agent_id=self.config.id,
                                agent_name=self.config.name or "router",
                                conversation_id=context.conversation_id,
                                frame_id=context.frame_id,
                            )

        except Exception as e:
            logger.error(f"Router processing failed: {e}", exc_info=True)
            yield StreamChunkEvent(
                content=f"Error: {e}",
                role="assistant",
                agent_id=self.config.id,
                agent_name=self.config.name or "router",
                conversation_id=context.conversation_id,
                frame_id=context.frame_id,
            )

    async def _handle_delegation(
        self,
        agent_id: int,
        tool_args: Dict,
        messages: List[Dict],
        context: AgentContext,
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Handle delegation to a sub-agent.

        Args:
            agent_id: ID of the agent to delegate to
            tool_args: Delegation arguments (task, context)
            messages: Current messages
            context: Agent context

        Yields:
            StreamChunkEvent from sub-agent
        """
        # Load agent config from database
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agent = agent_repo.get_by_user_and_id(context.user_id, agent_id)

            if not agent:
                yield StreamChunkEvent(
                    content=f"Agent not found: {agent_id}",
                    role="assistant",
                    agent_id=self.config.id,
                    agent_name=self.config.name or "router",
                    conversation_id=context.conversation_id,
                    frame_id=context.frame_id,
                )
                return

            agent_config = AgentConfig(
                id=agent.id,
                name=agent.name,
                system_prompt=agent.system_prompt or "",
                voice_reference=agent.voice_reference,
                avatar_uuid=agent.avatar_uuid,
                model_name=agent.model_name,
                tools=agent.tools or [],
                think=agent.think,
            )

        # Add delegation context to messages
        task = tool_args.get("task", "")
        extra_context = tool_args.get("context", "")

        delegation_msg = {
            "role": "user",
            "content": f"Task: {task}" + (f"\nContext: {extra_context}" if extra_context else "")
        }

        # Delegate
        async for chunk in self.delegate_to(
            agent_config,
            messages + [delegation_msg],
            context,
            reason=f"Delegating task: {task[:50]}..."
        ):
            yield chunk
