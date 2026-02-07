"""Administrator agent - LLM-based conversation orchestrator using routing tools.

The Administrator is a system-level agent that:
1. Receives ALL messages (from user and agents)
2. Uses routing tools to decide who should respond next
3. Streams its thinking and decision like regular agents
"""

import json
import logging
from typing import List, Dict, Optional, Any, AsyncGenerator

from .base import AgentConfig, async_iterate
from .orchestration import AdministratorDecision, OrchestrationSession
from llm import create_llm_provider
from tools.routing import create_routing_tools, parse_routing_result
from websocket.events import StreamChunkEvent

logger = logging.getLogger(__name__)

# Administrator agent name constant
ADMINISTRATOR_NAME = "Administrator"

# System prompt for the Administrator
ADMINISTRATOR_SYSTEM_PROMPT = """You are a conversation router (Administrator). Your job is to analyze messages and route them to the appropriate agents.

You have two routing tools:
1. route_to_agent - Route to a specific agent. You can call this MULTIPLE TIMES to route to several agents sequentially.
2. route_to_user - Return control to the user when all responses are complete.

ROUTING RULES:
- If the user's message involves multiple agents, call route_to_agent for EACH relevant agent in order.
- If only one agent is needed, call route_to_agent once.
- If an agent's response contains a question for the user, route to user.
- If an agent mentions another agent by name or asks for their help, route to that agent.
- If an agent's response is a complete answer with no pending questions, route to user.
- If an agent explicitly addresses the user, route to user.
- When in doubt, route to user.

You MUST use the routing tools to make your decision. Do not respond with text."""


def _build_chat_messages(
    system_prompt: str,
    conversation_history: Optional[List[Dict]],
    instruction: str,
) -> List[Dict]:
    """Build a messages array for the Administrator LLM call.

    Converts conversation history into native chat messages so the LLM
    sees them as actual turns rather than text in a single prompt.
    """
    messages = [{"role": "system", "content": system_prompt}]

    # Add conversation history as native messages
    # From Administrator's perspective: only its own messages are "assistant",
    # everything else (user messages, other agents' messages) are "user" input.
    if conversation_history:
        for msg in conversation_history:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            agent_name = msg.get("agent_name", "")

            if role == "system":
                chat_role = "system"
            elif agent_name == ADMINISTRATOR_NAME:
                chat_role = "assistant"
            else:
                chat_role = "user"

            if agent_name and agent_name != ADMINISTRATOR_NAME:
                content = f"[{agent_name}]: {content}"
            elif role == "user":
                content = f"[User]: {content}"

            messages.append({"role": chat_role, "content": content})

    # Final instruction as user message
    messages.append({"role": "user", "content": instruction})
    return messages


class AdministratorAgent:
    """LLM-based conversation orchestrator using routing tools.

    Streams its thinking and decisions like regular agents.
    """

    def __init__(
        self,
        agent_id: Optional[int] = None,
        model_name: str = "gemma3:4b",
        api_url: Optional[str] = None,
        think: bool = False,
    ):
        """Initialize the Administrator.

        Args:
            agent_id: Database ID of Administrator agent
            model_name: LLM model to use for routing decisions
            api_url: Optional custom LLM API URL
            think: Enable extended thinking for routing decisions
        """
        self.agent_id = agent_id
        self.model_name = model_name
        self.api_url = api_url
        self.think = think
        self._llm = None

    @property
    def llm(self):
        """Lazy-load LLM provider."""
        if self._llm is None:
            self._llm = create_llm_provider("ollama", api_url=self.api_url)
        return self._llm

    async def stream_routing_decision(
        self,
        latest_message: Dict[str, Any],
        available_agents: List[AgentConfig],
        session: OrchestrationSession,
        conversation_history: Optional[List[Dict]] = None,
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Stream the routing decision process, yielding chunks like regular agents.

        Args:
            latest_message: The message to analyze
            available_agents: List of agents that can receive messages
            session: Current orchestration session
            conversation_history: Recent conversation context

        Yields:
            StreamChunkEvent for thinking and content
        """
        # Build agent name list and lookup
        agent_names = [agent.name for agent in available_agents]
        agent_by_name = {agent.name.lower(): agent for agent in available_agents}

        # Create routing tools with available agents
        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        # Build the routing instruction
        latest_content = latest_message.get("content", "")
        latest_agent = latest_message.get("agent_name", "User")

        instruction = f"""Available agents: {', '.join(agent_names)}

Latest message from {latest_agent}:
{latest_content}

Use a routing tool to decide who should receive this message."""

        messages = _build_chat_messages(
            ADMINISTRATOR_SYSTEM_PROMPT,
            conversation_history,
            instruction,
        )

        # Store raw input on session
        session.last_raw_input = json.dumps(messages, ensure_ascii=False, default=str)

        try:
            # Log input
            logger.info(f"[Administrator] Routing decision - Model: {self.model_name}")

            # Call LLM with routing tools - stream the response
            stream = self.llm.chat(
                model=self.model_name,
                messages=messages,
                tools=tool_schemas,
                stream=True,
                think=self.think,
            )

            tool_calls = []
            full_content = ""
            async for chunk in async_iterate(stream):
                msg = chunk.message

                # Stream thinking
                thinking = getattr(msg, 'thinking', None)
                if thinking:
                    yield StreamChunkEvent(
                        content="",
                        thinking=thinking,
                        role="assistant",
                        agent_id=self.agent_id,
                        agent_name=ADMINISTRATOR_NAME,
                        conversation_id=session.conversation_id,
                        frame_id=session.frame_id,
                    )

                # Stream content (if any)
                if msg.content:
                    full_content += msg.content
                    yield StreamChunkEvent(
                        content=msg.content,
                        role="assistant",
                        agent_id=self.agent_id,
                        agent_name=ADMINISTRATOR_NAME,
                        conversation_id=session.conversation_id,
                        frame_id=session.frame_id,
                    )

                # Collect tool calls
                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    tool_calls.extend(msg.tool_calls)

            # Store raw output on session
            session.last_raw_output = full_content

            # Log output
            if full_content:
                logger.info(f"[Administrator] Content: {full_content}")
            if tool_calls:
                for tc in tool_calls:
                    logger.info(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

            # Process all tool calls — LLM may route to multiple agents sequentially
            if tool_calls:
                decisions = []
                for tool_call in tool_calls:
                    tool_name = tool_call.function.name
                    args = tool_call.function.arguments
                    tool_args = args if isinstance(args, dict) else json.loads(args)

                    for tool in routing_tools:
                        if tool.name == tool_name:
                            result = await tool.execute(tool_args)
                            routing = parse_routing_result(result)
                            decisions.append(routing)

                            if routing["action"] == "route_to_agent":
                                decision_text = f"→ Routing to {routing['agent_name']}: {routing['reason']}"
                            else:
                                decision_text = f"→ Returning to user: {routing['reason']}"

                            yield StreamChunkEvent(
                                content=decision_text + "\n",
                                role="tool",
                                agent_id=self.agent_id,
                                agent_name=tool_name,
                                conversation_id=session.conversation_id,
                                frame_id=session.frame_id,
                            )

                # Store decisions on session for the orchestration loop to consume
                session.pending_routes = decisions
            else:
                yield StreamChunkEvent(
                    content="→ No routing decision made, returning to user",
                    role="tool",
                    agent_id=self.agent_id,
                    agent_name="route_to_user",
                    conversation_id=session.conversation_id,
                    frame_id=session.frame_id,
                )
                session.pending_routes = [{"action": "route_to_user", "agent_name": None, "reason": "No routing decision"}]

        except Exception as e:
            logger.error(f"Administrator routing failed: {e}", exc_info=True)
            yield StreamChunkEvent(
                content=f"→ Error: {e}",
                role="assistant",
                agent_id=self.agent_id,
                agent_name=ADMINISTRATOR_NAME,
                conversation_id=session.conversation_id,
                frame_id=session.frame_id,
            )

    async def decide_routing(
        self,
        latest_message: Dict[str, Any],
        available_agents: List[AgentConfig],
        session: OrchestrationSession,
        conversation_history: Optional[List[Dict]] = None,
    ) -> AdministratorDecision:
        """Analyze a message and decide where to route it (non-streaming version).

        Args:
            latest_message: The message to analyze
            available_agents: List of agents that can receive messages
            session: Current orchestration session
            conversation_history: Recent conversation context

        Returns:
            AdministratorDecision
        """
        # Build agent name list and lookup
        agent_names = [agent.name for agent in available_agents]
        agent_by_name = {agent.name.lower(): agent for agent in available_agents}

        # Create routing tools with available agents
        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        # Build the routing instruction
        latest_content = latest_message.get("content", "")
        latest_agent = latest_message.get("agent_name", "User")

        instruction = f"""Available agents: {', '.join(agent_names)}

Latest message from {latest_agent}:
{latest_content}

Use a routing tool to decide who should receive this message."""

        messages = _build_chat_messages(
            ADMINISTRATOR_SYSTEM_PROMPT,
            conversation_history,
            instruction,
        )

        try:
            # Log input
            logger.info(f"[Administrator] Routing decision (non-streaming) - Model: {self.model_name}")

            # Call LLM with routing tools
            stream = self.llm.chat(
                model=self.model_name,
                messages=messages,
                tools=tool_schemas,
                stream=True,
                think=self.think,
            )

            tool_calls = []
            async for chunk in async_iterate(stream):
                msg = chunk.message
                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    tool_calls.extend(msg.tool_calls)

            # Log tool calls
            if tool_calls:
                for tc in tool_calls:
                    logger.info(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

            # Process tool calls
            if tool_calls:
                for tool_call in tool_calls:
                    tool_name = tool_call.function.name
                    tool_args = (tool_call.function.arguments if isinstance(tool_call.function.arguments, dict) else json.loads(tool_call.function.arguments))

                    # Find and execute the routing tool
                    for tool in routing_tools:
                        if tool.name == tool_name:
                            result = await tool.execute(tool_args)
                            routing = parse_routing_result(result)

                            if routing["action"] == "route_to_agent":
                                agent_name = routing["agent_name"]
                                agent = agent_by_name.get(agent_name.lower())
                                if agent:
                                    logger.info(f"[Administrator] Routing to agent: {agent.name}")
                                    return AdministratorDecision.to_agent(
                                        agent_id=agent.id,
                                        agent_name=agent.name,
                                        reason=routing["reason"],
                                    )
                                else:
                                    logger.warning(f"[Administrator] Agent not found: {agent_name}")
                                    return AdministratorDecision.to_user(
                                        reason=f"Agent '{agent_name}' not found"
                                    )
                            else:
                                logger.info(f"[Administrator] Routing to user: {routing['reason']}")
                                return AdministratorDecision.to_user(
                                    reason=routing["reason"]
                                )

            # No tool calls - default to user
            logger.warning("[Administrator] Did not call routing tools, returning to user")
            return AdministratorDecision.to_user(reason="No routing decision made")

        except Exception as e:
            logger.error(f"[Administrator] Routing failed: {e}", exc_info=True)
            return AdministratorDecision.to_user(reason=f"Error: {e}")

    async def stream_initial_selection(
        self,
        user_message: str,
        available_agents: List[AgentConfig],
        session: OrchestrationSession,
        conversation_history: Optional[List[Dict]] = None,
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Stream the initial agent selection process.

        Args:
            user_message: The user's message
            available_agents: List of available agents
            session: Current orchestration session
            conversation_history: Full conversation context

        Yields:
            StreamChunkEvent for thinking and content
        """
        if not available_agents:
            yield StreamChunkEvent(
                content="→ No agents available",
                role="assistant",
                agent_id=self.agent_id,
                agent_name=ADMINISTRATOR_NAME,
                conversation_id=session.conversation_id,
                frame_id=session.frame_id,
            )
            return

        # If only one agent, use it directly
        if len(available_agents) == 1:
            yield StreamChunkEvent(
                content=f"→ Selected {available_agents[0].name} (only available agent)",
                role="assistant",
                agent_id=self.agent_id,
                agent_name=ADMINISTRATOR_NAME,
                conversation_id=session.conversation_id,
                frame_id=session.frame_id,
            )
            return

        # Build agent name list
        agent_names = [agent.name for agent in available_agents]

        # Create routing tools
        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        # Build agent descriptions
        agent_descriptions = []
        for agent in available_agents:
            desc = f"- {agent.name}: {agent.system_prompt[:100]}..." if agent.system_prompt else f"- {agent.name}: General assistant"
            agent_descriptions.append(desc)

        instruction = f"""Select which agent should handle this user message.

Available agents:
{chr(10).join(agent_descriptions)}

User's message: {user_message[:500]}

Use route_to_agent to select the best agent for this task."""

        messages = _build_chat_messages(
            "You are an agent selector. Use route_to_agent to select the best agent(s). You can call route_to_agent multiple times to select several agents sequentially.",
            conversation_history,
            instruction,
        )

        # Store raw input on session
        session.last_raw_input = json.dumps(messages, ensure_ascii=False, default=str)

        try:
            # Log input
            logger.info(f"[Administrator] Initial selection - Model: {self.model_name}")

            stream = self.llm.chat(
                model=self.model_name,
                messages=messages,
                tools=tool_schemas,
                stream=True,
                think=self.think,
            )

            tool_calls = []
            full_content = ""
            async for chunk in async_iterate(stream):
                msg = chunk.message

                # Stream thinking
                thinking = getattr(msg, 'thinking', None)
                if thinking:
                    yield StreamChunkEvent(
                        content="",
                        thinking=thinking,
                        role="assistant",
                        agent_id=self.agent_id,
                        agent_name=ADMINISTRATOR_NAME,
                        conversation_id=session.conversation_id,
                        frame_id=session.frame_id,
                    )

                # Stream content
                if msg.content:
                    full_content += msg.content
                    yield StreamChunkEvent(
                        content=msg.content,
                        role="assistant",
                        agent_id=self.agent_id,
                        agent_name=ADMINISTRATOR_NAME,
                        conversation_id=session.conversation_id,
                        frame_id=session.frame_id,
                    )

                # Collect tool calls
                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    tool_calls.extend(msg.tool_calls)

            # Store raw output on session
            session.last_raw_output = full_content

            # Log output
            if full_content:
                logger.info(f"[Administrator] Content: {full_content}")
            if tool_calls:
                for tc in tool_calls:
                    logger.info(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

            # Process all tool calls — LLM may select multiple agents sequentially
            if tool_calls:
                decisions = []
                for tool_call in tool_calls:
                    if tool_call.function.name == "route_to_agent":
                        tool_args = (tool_call.function.arguments if isinstance(tool_call.function.arguments, dict) else json.loads(tool_call.function.arguments))
                        agent_name = tool_args.get("agent_name", "")
                        reason = tool_args.get("reason", "")
                        decisions.append({"action": "route_to_agent", "agent_name": agent_name, "reason": reason})

                        yield StreamChunkEvent(
                            content=f"→ Selected {agent_name}: {reason}\n",
                            role="tool",
                            agent_id=self.agent_id,
                            agent_name="route_to_agent",
                            conversation_id=session.conversation_id,
                            frame_id=session.frame_id,
                        )

                if decisions:
                    session.pending_routes = decisions
                    return

            # Default
            logger.info(f"[Administrator] No agent selected via tool, using default: {available_agents[0].name}")
            session.pending_routes = [{"action": "route_to_agent", "agent_name": available_agents[0].name, "reason": "default"}]
            yield StreamChunkEvent(
                content=f"→ Selected {available_agents[0].name} (default)",
                role="tool",
                agent_id=self.agent_id,
                agent_name="route_to_agent",
                conversation_id=session.conversation_id,
                frame_id=session.frame_id,
            )

        except Exception as e:
            logger.error(f"Agent selection failed: {e}", exc_info=True)
            yield StreamChunkEvent(
                content=f"→ Error selecting agent: {e}, using {available_agents[0].name}",
                role="assistant",
                agent_id=self.agent_id,
                agent_name=ADMINISTRATOR_NAME,
                conversation_id=session.conversation_id,
                frame_id=session.frame_id,
            )

    async def select_initial_agent(
        self,
        user_message: str,
        available_agents: List[AgentConfig],
        session: OrchestrationSession,
        conversation_history: Optional[List[Dict]] = None,
    ) -> Optional[AgentConfig]:
        """Select which agent should handle an initial user message (non-streaming).

        Args:
            user_message: The user's message
            available_agents: List of available agents
            session: Current orchestration session
            conversation_history: Full conversation context

        Returns:
            Selected agent config or None
        """
        if not available_agents:
            return None

        # If only one agent, use it directly
        if len(available_agents) == 1:
            return available_agents[0]

        # Build agent name list and lookup
        agent_names = [agent.name for agent in available_agents]
        agent_by_name = {agent.name.lower(): agent for agent in available_agents}

        # Create routing tools
        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        # Build agent descriptions
        agent_descriptions = []
        for agent in available_agents:
            desc = f"- {agent.name}: {agent.system_prompt[:100]}..." if agent.system_prompt else f"- {agent.name}: General assistant"
            agent_descriptions.append(desc)

        instruction = f"""Select which agent should handle this user message.

Available agents:
{chr(10).join(agent_descriptions)}

User's message: {user_message[:500]}

Use route_to_agent to select the best agent for this task."""

        messages = _build_chat_messages(
            "You are an agent selector. Use route_to_agent to select the best agent(s). You can call route_to_agent multiple times to select several agents sequentially.",
            conversation_history,
            instruction,
        )

        try:
            # Log input
            logger.info(f"[Administrator] Initial selection (non-streaming) - Model: {self.model_name}")

            stream = self.llm.chat(
                model=self.model_name,
                messages=messages,
                tools=tool_schemas,
                stream=True,
                think=self.think,
            )

            tool_calls = []
            async for chunk in async_iterate(stream):
                msg = chunk.message
                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    tool_calls.extend(msg.tool_calls)

            # Log tool calls
            if tool_calls:
                for tc in tool_calls:
                    logger.info(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

                for tool_call in tool_calls:
                    if tool_call.function.name == "route_to_agent":
                        tool_args = (tool_call.function.arguments if isinstance(tool_call.function.arguments, dict) else json.loads(tool_call.function.arguments))
                        agent_name = tool_args.get("agent_name", "")
                        agent = agent_by_name.get(agent_name.lower())
                        if agent:
                            logger.info(f"[Administrator] Selected agent: {agent.name}")
                            return agent

            # Default to first agent
            logger.warning(f"[Administrator] No agent selected, using first available: {available_agents[0].name}")
            return available_agents[0]

        except Exception as e:
            logger.error(f"[Administrator] Agent selection failed: {e}", exc_info=True)
            return available_agents[0]
