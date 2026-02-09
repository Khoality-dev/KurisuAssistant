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
ADMINISTRATOR_SYSTEM_PROMPT = """You moderate a group chat. Everyone — the user and the agents — are equal participants. Your only job is to decide who speaks next using the routing tools.

Tools:
- route_to_agent: Let an agent speak. Call multiple times to queue several.
- route_to_user: Let the user speak (it's their turn).

Guidelines:
- If someone is addressed or mentioned by name, let them speak.
- If multiple people would naturally want to chime in, queue them.
- When the conversation needs user input or feels like the user's turn, route to user.
- Not every message needs a reply from everyone — let it flow naturally.

You MUST call a routing tool. Do not reply with text."""


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
            speaker = msg.get("name", "")

            if role == "system":
                chat_role = "system"
            elif speaker == ADMINISTRATOR_NAME:
                chat_role = "assistant"
            else:
                chat_role = "user"

            if speaker and speaker != ADMINISTRATOR_NAME:
                content = f"[{speaker}]: {content}"
            elif role == "user":
                content = f"[User]: {content}"

            messages.append({"role": chat_role, "content": content})

    # Final instruction as user message
    messages.append({"role": "user", "content": instruction})
    return messages


class AdministratorAgent:
    """LLM-based conversation orchestrator using routing tools.

    Streams its thinking and decisions like regular agents.
    All chunks (including tool results) use name=ADMINISTRATOR_NAME
    so _prepare_messages can filter them from sub-agent context.
    """

    def __init__(
        self,
        agent_id: Optional[int] = None,
        model_name: str = "gemma3:4b",
        api_url: Optional[str] = None,
        think: bool = False,
    ):
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

    def _chunk(self, content: str, role: str, session: OrchestrationSession,
               thinking: Optional[str] = None, name: Optional[str] = None) -> StreamChunkEvent:
        """Create a StreamChunkEvent for the Administrator.

        Args:
            name: Override speaker name. Defaults to ADMINISTRATOR_NAME.
                  For tool results, pass the tool name.
        """
        return StreamChunkEvent(
            content=content,
            thinking=thinking,
            role=role,
            # agent_id only for assistant messages (for avatar/voice lookup)
            agent_id=self.agent_id if role == "assistant" else None,
            name=name or ADMINISTRATOR_NAME,
            conversation_id=session.conversation_id,
            frame_id=session.frame_id,
        )

    async def stream_routing_decision(
        self,
        latest_message: Dict[str, Any],
        available_agents: List[AgentConfig],
        session: OrchestrationSession,
        conversation_history: Optional[List[Dict]] = None,
    ) -> AsyncGenerator[StreamChunkEvent, None]:
        """Stream the routing decision process, yielding chunks like regular agents."""
        agent_names = [agent.name for agent in available_agents]

        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        latest_content = latest_message.get("content", "")
        latest_speaker = latest_message.get("name", "User")

        instruction = f"""People in this chat: {', '.join(agent_names)}, User

{latest_speaker} just said:
{latest_content}

Who speaks next? Use a routing tool."""

        messages = _build_chat_messages(
            ADMINISTRATOR_SYSTEM_PROMPT, conversation_history, instruction,
        )
        session.last_raw_input = json.dumps(messages, ensure_ascii=False, default=str)

        try:
            logger.debug(f"[Administrator] Routing decision - Model: {self.model_name}")

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

                thinking = getattr(msg, 'thinking', None)
                if thinking:
                    yield self._chunk("", "assistant", session, thinking=thinking)

                if msg.content:
                    full_content += msg.content
                    yield self._chunk(msg.content, "assistant", session)

                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    tool_calls.extend(msg.tool_calls)

            session.last_raw_output = full_content

            if full_content:
                logger.debug(f"[Administrator] Content: {full_content}")
            if tool_calls:
                for tc in tool_calls:
                    logger.debug(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

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

                            yield self._chunk(decision_text + "\n", "tool", session, name=tool_name)

                session.pending_routes = decisions
            else:
                yield self._chunk("→ No routing decision made, returning to user", "tool", session, name="route_to_user")
                session.pending_routes = [{"action": "route_to_user", "agent_name": None, "reason": "No routing decision"}]

        except Exception as e:
            logger.error(f"Administrator routing failed: {e}", exc_info=True)
            yield self._chunk(f"→ Error: {e}", "assistant", session)

    async def decide_routing(
        self,
        latest_message: Dict[str, Any],
        available_agents: List[AgentConfig],
        session: OrchestrationSession,
        conversation_history: Optional[List[Dict]] = None,
    ) -> AdministratorDecision:
        """Analyze a message and decide where to route it (non-streaming version)."""
        agent_names = [agent.name for agent in available_agents]
        agent_by_name = {agent.name.lower(): agent for agent in available_agents}

        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        latest_content = latest_message.get("content", "")
        latest_speaker = latest_message.get("name", "User")

        instruction = f"""People in this chat: {', '.join(agent_names)}, User

{latest_speaker} just said:
{latest_content}

Who speaks next? Use a routing tool."""

        messages = _build_chat_messages(
            ADMINISTRATOR_SYSTEM_PROMPT, conversation_history, instruction,
        )

        try:
            logger.debug(f"[Administrator] Routing decision (non-streaming) - Model: {self.model_name}")

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

            if tool_calls:
                for tc in tool_calls:
                    logger.debug(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

                for tool_call in tool_calls:
                    tool_name = tool_call.function.name
                    tool_args = (tool_call.function.arguments if isinstance(tool_call.function.arguments, dict) else json.loads(tool_call.function.arguments))

                    for tool in routing_tools:
                        if tool.name == tool_name:
                            result = await tool.execute(tool_args)
                            routing = parse_routing_result(result)

                            if routing["action"] == "route_to_agent":
                                target = routing["agent_name"]
                                agent = agent_by_name.get(target.lower())
                                if agent:
                                    logger.debug(f"[Administrator] Routing to agent: {agent.name}")
                                    return AdministratorDecision.to_agent(
                                        agent_id=agent.id,
                                        agent_name=agent.name,
                                        reason=routing["reason"],
                                    )
                                else:
                                    logger.warning(f"[Administrator] Agent not found: {target}")
                                    return AdministratorDecision.to_user(
                                        reason=f"Agent '{target}' not found"
                                    )
                            else:
                                logger.debug(f"[Administrator] Routing to user: {routing['reason']}")
                                return AdministratorDecision.to_user(reason=routing["reason"])

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
        """Stream the initial agent selection process."""
        if not available_agents:
            yield self._chunk("→ No agents available", "assistant", session)
            return

        if len(available_agents) == 1:
            yield self._chunk(
                f"→ Selected {available_agents[0].name} (only available agent)",
                "assistant", session,
            )
            return

        agent_names = [agent.name for agent in available_agents]
        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        agent_descriptions = []
        for agent in available_agents:
            desc = f"- {agent.name}: {agent.system_prompt[:100]}..." if agent.system_prompt else f"- {agent.name}: General assistant"
            agent_descriptions.append(desc)

        instruction = f"""The user just spoke. Who speaks next?

People in this chat:
{chr(10).join(agent_descriptions)}

User said: {user_message[:500]}

Use route_to_agent to pick who responds. You can pick multiple people."""

        messages = _build_chat_messages(
            ADMINISTRATOR_SYSTEM_PROMPT, conversation_history, instruction,
        )
        session.last_raw_input = json.dumps(messages, ensure_ascii=False, default=str)

        try:
            logger.debug(f"[Administrator] Initial selection - Model: {self.model_name}")

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

                thinking = getattr(msg, 'thinking', None)
                if thinking:
                    yield self._chunk("", "assistant", session, thinking=thinking)

                if msg.content:
                    full_content += msg.content
                    yield self._chunk(msg.content, "assistant", session)

                if hasattr(msg, 'tool_calls') and msg.tool_calls:
                    tool_calls.extend(msg.tool_calls)

            session.last_raw_output = full_content

            if full_content:
                logger.debug(f"[Administrator] Content: {full_content}")
            if tool_calls:
                for tc in tool_calls:
                    logger.debug(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

            if tool_calls:
                decisions = []
                for tool_call in tool_calls:
                    if tool_call.function.name == "route_to_agent":
                        tool_args = (tool_call.function.arguments if isinstance(tool_call.function.arguments, dict) else json.loads(tool_call.function.arguments))
                        target = tool_args.get("agent_name", "")
                        reason = tool_args.get("reason", "")
                        decisions.append({"action": "route_to_agent", "agent_name": target, "reason": reason})

                        yield self._chunk(f"→ Selected {target}: {reason}\n", "tool", session, name="route_to_agent")

                if decisions:
                    session.pending_routes = decisions
                    return

            logger.debug(f"[Administrator] No agent selected via tool, using default: {available_agents[0].name}")
            session.pending_routes = [{"action": "route_to_agent", "agent_name": available_agents[0].name, "reason": "default"}]
            yield self._chunk(f"→ Selected {available_agents[0].name} (default)", "tool", session, name="route_to_agent")

        except Exception as e:
            logger.error(f"Agent selection failed: {e}", exc_info=True)
            yield self._chunk(
                f"→ Error selecting agent: {e}, using {available_agents[0].name}",
                "assistant", session,
            )

    async def select_initial_agent(
        self,
        user_message: str,
        available_agents: List[AgentConfig],
        session: OrchestrationSession,
        conversation_history: Optional[List[Dict]] = None,
    ) -> Optional[AgentConfig]:
        """Select which agent should handle an initial user message (non-streaming)."""
        if not available_agents:
            return None

        if len(available_agents) == 1:
            return available_agents[0]

        agent_names = [agent.name for agent in available_agents]
        agent_by_name = {agent.name.lower(): agent for agent in available_agents}

        routing_tools = create_routing_tools(agent_names)
        tool_schemas = [tool.get_schema() for tool in routing_tools]

        agent_descriptions = []
        for agent in available_agents:
            desc = f"- {agent.name}: {agent.system_prompt[:100]}..." if agent.system_prompt else f"- {agent.name}: General assistant"
            agent_descriptions.append(desc)

        instruction = f"""The user just spoke. Who speaks next?

People in this chat:
{chr(10).join(agent_descriptions)}

User said: {user_message[:500]}

Use route_to_agent to pick who responds. You can pick multiple people."""

        messages = _build_chat_messages(
            ADMINISTRATOR_SYSTEM_PROMPT, conversation_history, instruction,
        )

        try:
            logger.debug(f"[Administrator] Initial selection (non-streaming) - Model: {self.model_name}")

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

            if tool_calls:
                for tc in tool_calls:
                    logger.debug(f"[Administrator] Tool call: {tc.function.name}({tc.function.arguments})")

                for tool_call in tool_calls:
                    if tool_call.function.name == "route_to_agent":
                        tool_args = (tool_call.function.arguments if isinstance(tool_call.function.arguments, dict) else json.loads(tool_call.function.arguments))
                        target = tool_args.get("agent_name", "")
                        agent = agent_by_name.get(target.lower())
                        if agent:
                            logger.debug(f"[Administrator] Selected agent: {agent.name}")
                            return agent

            logger.warning(f"[Administrator] No agent selected, using first available: {available_agents[0].name}")
            return available_agents[0]

        except Exception as e:
            logger.error(f"[Administrator] Agent selection failed: {e}", exc_info=True)
            return available_agents[0]
