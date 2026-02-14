"""WebSocket session handlers with turn-based orchestration."""

import asyncio
import json
import logging
from typing import Dict, List, Optional

from fastapi import WebSocket

from .events import (
    EventType,
    BaseEvent,
    ChatRequestEvent,
    ToolApprovalRequestEvent,
    ToolApprovalResponseEvent,
    StreamChunkEvent,
    DoneEvent,
    ErrorEvent,
    CancelEvent,
    AgentSwitchEvent,
    VisionStartEvent,
    VisionFrameEvent,
    VisionStopEvent,
    VisionResultEvent,
    parse_event,
)
from agents.base import AgentConfig, AgentContext, BaseAgent, SimpleAgent
from agents.orchestration import OrchestrationSession
from agents.administrator import AdministratorAgent
from tools import tool_registry
from vision import VisionProcessor
from db.session import get_session
from db.repositories import (
    ConversationRepository,
    FrameRepository,
    MessageRepository,
    UserRepository,
    AgentRepository,
)
from utils.prompts import build_system_messages

logger = logging.getLogger(__name__)

# Default configuration
DEFAULT_MAX_TURNS = 10
DEFAULT_ADMIN_MODEL = "gemma3:4b"  # Fallback if Administrator agent not found
ADMINISTRATOR_NAME = "Administrator"  # Reserved agent name for routing


class ChatSessionHandler:
    """Handles a single WebSocket chat session with turn-based orchestration.

    The handler uses an Administrator agent to route messages between
    user-created agents, enabling agent-to-agent communication.

    Turn Flow:
    1. User sends message
    2. Administrator selects initial agent
    3. Agent processes and responds
    4. Administrator analyzes response to determine next target
    5. If target is another agent, continue; if user, end turn cycle
    """

    def __init__(self, websocket: WebSocket, user_id: int):
        self.websocket = websocket
        self.user_id = user_id
        self.pending_approvals: Dict[str, asyncio.Future] = {}
        self.current_task: Optional[asyncio.Task] = None

        # Administrator for routing decisions
        self.administrator: Optional[AdministratorAgent] = None

        # Accumulated complete messages for replay on reconnect
        self._accumulated_messages: List[dict] = []
        # In-progress chunk (agent still generating)
        self._current_chunk: Optional[dict] = None
        # Task metadata for replay events
        self._task_conversation_id: Optional[int] = None
        self._task_frame_id: Optional[int] = None
        self._task_done: bool = False

        # Vision processing
        self._vision_processor: Optional[VisionProcessor] = None

    async def run(self):
        """Main handler loop - receives and processes events."""
        from fastapi import WebSocketDisconnect
        while True:
            try:
                data = await self.websocket.receive_json()
                event = parse_event(data)
                await self._handle_event(event)
            except WebSocketDisconnect:
                raise
            except Exception as e:
                logger.error(f"Error handling WebSocket event: {e}", exc_info=True)
                await self.send_event(ErrorEvent(
                    error=str(e),
                    code="INTERNAL_ERROR",
                ))

    async def _handle_event(self, event: BaseEvent):
        """Route event to appropriate handler."""
        if isinstance(event, ChatRequestEvent):
            await self._handle_chat_request(event)
        elif isinstance(event, ToolApprovalResponseEvent):
            await self._handle_approval_response(event)
        elif isinstance(event, CancelEvent):
            await self._handle_cancel()
        elif isinstance(event, VisionStartEvent):
            await self._handle_vision_start(event)
        elif isinstance(event, VisionFrameEvent):
            await self._handle_vision_frame(event)
        elif isinstance(event, VisionStopEvent):
            await self._handle_vision_stop()

    async def _handle_chat_request(self, event: ChatRequestEvent):
        """Handle incoming chat request."""
        # Cancel any existing task (force interrupt)
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                pass

        # Branch: single agent mode (direct) vs orchestration (Administrator routing)
        if event.agent_id is not None:
            self.current_task = asyncio.create_task(
                self._run_single_agent(event)
            )
        else:
            self.current_task = asyncio.create_task(
                self._run_orchestration(event)
            )

    async def _run_single_agent(self, event: ChatRequestEvent):
        """Run a single agent directly, bypassing Administrator routing.

        This is a simplified path for single-agent conversations:
        setup → agent.process() → save → DoneEvent.
        No OrchestrationSession, no Administrator, no routing loop.
        """
        from fastapi import WebSocketDisconnect
        try:
            # Setup conversation/frame
            conversation_id, frame_id, system_messages, user_system_prompt, preferred_name = await self._setup_conversation(event)

            # Reset accumulated state for new task
            self._accumulated_messages = []
            self._current_chunk = None
            self._task_conversation_id = conversation_id
            self._task_frame_id = frame_id
            self._task_done = False

            # Load agents and find the target
            all_agents = self._load_user_agents()
            available_agents = [a for a in all_agents if a.name != ADMINISTRATOR_NAME]
            target_agent = self._get_agent_config(event.agent_id, available_agents)

            if not target_agent:
                await self.send_event(ErrorEvent(
                    error=f"Agent not found: {event.agent_id}",
                    code="AGENT_NOT_FOUND",
                ))
                return

            # Load context messages
            context_messages = self._load_context_messages(conversation_id, frame_id)

            # Build messages
            user_message = {"role": "user", "content": event.text}
            messages = system_messages + context_messages + [user_message]
            messages_to_save = [user_message]

            # Create agent context
            agent_context = AgentContext(
                user_id=self.user_id,
                conversation_id=conversation_id,
                frame_id=frame_id,
                model_name=target_agent.model_name or event.model_name or DEFAULT_ADMIN_MODEL,
                handler=self,
                available_agents=available_agents,
                user_system_prompt=user_system_prompt,
                preferred_name=preferred_name,
            )

            # Create and run the agent
            agent = self._create_agent(target_agent)

            # Collect agent's response
            current_role = "assistant"
            current_name = target_agent.name
            chunk_content = ""
            chunk_thinking = ""
            raw_input_json = None

            async for chunk in agent.process(messages, agent_context):
                # Capture raw input on first chunk
                if raw_input_json is None:
                    raw_input_json = json.dumps(
                        getattr(agent, 'last_prepared_messages', messages),
                        ensure_ascii=False, default=str,
                    )

                # Attach agent voice reference for TTS
                chunk.voice_reference = target_agent.voice_reference
                await self.send_event(chunk)

                # Accumulate for saving
                if chunk.role != current_role:
                    if chunk_content or chunk_thinking:
                        completed_msg = {
                            "role": current_role,
                            "content": chunk_content,
                            "thinking": chunk_thinking if chunk_thinking else None,
                            "agent_id": target_agent.id if current_role == "assistant" else None,
                            "name": current_name,
                            "raw_input": raw_input_json if current_role == "assistant" else None,
                            "raw_output": chunk_content if current_role == "assistant" else None,
                        }
                        messages_to_save.append(completed_msg)
                        self._accumulated_messages.append(completed_msg)
                    current_role = chunk.role
                    current_name = chunk.name or target_agent.name
                    chunk_content = chunk.content
                    chunk_thinking = chunk.thinking or ""
                else:
                    chunk_content += chunk.content
                    if chunk.thinking:
                        chunk_thinking += chunk.thinking

                # Update in-progress chunk for reconnect replay
                self._current_chunk = {
                    "role": current_role,
                    "content": chunk_content,
                    "thinking": chunk_thinking if chunk_thinking else None,
                    "agent_id": target_agent.id if current_role == "assistant" else None,
                    "name": current_name,
                }

            # Save final accumulated content
            if chunk_content or chunk_thinking:
                completed_msg = {
                    "role": current_role,
                    "content": chunk_content,
                    "thinking": chunk_thinking if chunk_thinking else None,
                    "agent_id": target_agent.id if current_role == "assistant" else None,
                    "name": current_name,
                    "raw_input": raw_input_json if current_role == "assistant" else None,
                    "raw_output": chunk_content if current_role == "assistant" else None,
                }
                messages_to_save.append(completed_msg)
                self._accumulated_messages.append(completed_msg)

            # Persist messages to DB
            await self._save_messages(messages_to_save, frame_id)
            self._update_timestamps(frame_id, conversation_id)

            # Mark task as done
            self._current_chunk = None
            self._task_done = True
            await self.send_event(DoneEvent(
                conversation_id=conversation_id,
                frame_id=frame_id,
            ))

        except asyncio.CancelledError:
            logger.debug("Single agent task cancelled by user")
        except WebSocketDisconnect:
            raise
        except Exception as e:
            logger.error(f"Single agent task failed: {e}", exc_info=True)
            await self.send_event(ErrorEvent(
                error=str(e),
                code="INTERNAL_ERROR",
            ))

    async def _run_orchestration(self, event: ChatRequestEvent):
        """Run the turn-based orchestration loop.

        This is the main orchestration flow:
        1. Setup conversation and session
        2. Administrator selects initial agent
        3. Loop: agent processes -> Administrator routes -> repeat until user
        4. Persist messages and cleanup
        """
        try:
            # Setup conversation/frame
            conversation_id, frame_id, system_messages, user_system_prompt, preferred_name = await self._setup_conversation(event)

            # Reset accumulated state for new task
            self._accumulated_messages = []
            self._current_chunk = None
            self._task_conversation_id = conversation_id
            self._task_frame_id = frame_id
            self._task_done = False

            # Create orchestration session
            session = OrchestrationSession(
                conversation_id=conversation_id,
                frame_id=frame_id,
                user_id=self.user_id,
                max_turns=DEFAULT_MAX_TURNS,
            )

            # Load all agents including Administrator
            all_agents = self._load_user_agents()

            # Find Administrator agent and get its model
            admin_agent = None
            available_agents = []
            for agent in all_agents:
                if agent.name == ADMINISTRATOR_NAME:
                    admin_agent = agent
                else:
                    available_agents.append(agent)

            # Initialize or update Administrator with model from database
            admin_model = admin_agent.model_name if admin_agent and admin_agent.model_name else DEFAULT_ADMIN_MODEL
            admin_id = admin_agent.id if admin_agent else None
            admin_think = admin_agent.think if admin_agent else False
            if self.administrator is None or self.administrator.model_name != admin_model or self.administrator.think != admin_think:
                self.administrator = AdministratorAgent(
                    agent_id=admin_id,
                    model_name=admin_model,
                    think=admin_think,
                )

            if not available_agents:
                # No non-Administrator agents available, send error
                await self.send_event(ErrorEvent(
                    error="No agents available. Please create at least one agent.",
                    code="NO_AGENTS",
                ))
                return

            # Load context messages
            context_messages = self._load_context_messages(conversation_id, frame_id)

            # Build initial messages
            user_message = {
                "role": "user",
                "content": event.text,
            }

            # Messages for context (system + context + user)
            messages = system_messages + context_messages + [user_message]

            # Messages to save to DB (will accumulate during orchestration)
            messages_to_save = [user_message]

            # Select initial agent
            if event.agent_id:
                # User explicitly selected an agent
                selected_agent = self._get_agent_config(event.agent_id, available_agents)
                if not selected_agent:
                    selected_agent = available_agents[0]
                # Send simple selection message
                admin_selection_content = f"→ Using selected agent: {selected_agent.name}"
                await self.send_event(StreamChunkEvent(
                    content=admin_selection_content,
                    role="assistant",
                    agent_id=admin_id,
                    name=ADMINISTRATOR_NAME,
                    conversation_id=conversation_id,
                    frame_id=frame_id,
                ))
                # Save Administrator selection message
                admin_sel_msg = {
                    "role": "assistant",
                    "content": admin_selection_content,
                    "thinking": None,
                    "agent_id": admin_id,
                    "name": ADMINISTRATOR_NAME,
                }
                messages_to_save.append(admin_sel_msg)
                self._accumulated_messages.append(admin_sel_msg)
                # Queue the selected agent
                session.pending_routes = [{"action": "route_to_agent", "agent_name": selected_agent.name, "reason": "User selected"}]
            else:
                # Administrator selects agent(s) using routing tools - stream the process
                admin_role = "assistant"
                admin_name = ADMINISTRATOR_NAME
                admin_content = ""
                admin_thinking = ""

                async for chunk in self.administrator.stream_initial_selection(
                    user_message=event.text,
                    available_agents=available_agents,
                    session=session,
                    conversation_history=messages,
                ):
                    await self.send_event(chunk)

                    if chunk.role != admin_role:
                        # Role changed (e.g. assistant → tool), save accumulated
                        if admin_content or admin_thinking:
                            msg = {
                                "role": admin_role,
                                "content": admin_content,
                                "thinking": admin_thinking if admin_thinking else None,
                                "agent_id": admin_id if admin_role == "assistant" else None,
                                "name": admin_name,
                                "raw_input": session.last_raw_input if admin_role == "assistant" else None,
                                "raw_output": session.last_raw_output if admin_role == "assistant" else None,
                            }
                            messages_to_save.append(msg)
                            self._accumulated_messages.append(msg)
                        admin_role = chunk.role
                        admin_name = chunk.name or ADMINISTRATOR_NAME
                        admin_content = chunk.content
                        admin_thinking = chunk.thinking or ""
                    else:
                        admin_content += chunk.content
                        if chunk.thinking:
                            admin_thinking += chunk.thinking

                # Save final accumulated content
                if admin_content or admin_thinking:
                    admin_sel_msg = {
                        "role": admin_role,
                        "content": admin_content,
                        "thinking": admin_thinking if admin_thinking else None,
                        "agent_id": admin_id if admin_role == "assistant" else None,
                        "name": admin_name,
                        "raw_input": session.last_raw_input if admin_role == "assistant" else None,
                        "raw_output": session.last_raw_output if admin_role == "assistant" else None,
                    }
                    messages_to_save.append(admin_sel_msg)
                    self._accumulated_messages.append(admin_sel_msg)

            # Create agent context
            agent_context = AgentContext(
                user_id=self.user_id,
                conversation_id=conversation_id,
                frame_id=frame_id,
                model_name=event.model_name or DEFAULT_ADMIN_MODEL,
                handler=self,
                available_agents=available_agents,
                user_system_prompt=user_system_prompt,
                preferred_name=preferred_name,
            )

            # Build agent lookup
            agent_by_name = {a.name.lower(): a for a in available_agents}

            # ========================================
            # ORCHESTRATION LOOP
            # ========================================
            conversation_messages = list(messages)  # Copy for mutation

            while session.increment_turn():
                if session.is_cancelled:
                    break

                # Get next agent from pending routes
                if not session.pending_routes:
                    # No more routes queued — ask Administrator for routing decision
                    latest_message = {
                        "role": "assistant",
                        "content": conversation_messages[-1].get("content", "") if conversation_messages else "",
                        "agent_id": session.current_agent_id,
                        "name": session.current_agent_name,
                    }

                    admin_role = "assistant"
                    admin_name = ADMINISTRATOR_NAME
                    routing_content = ""
                    routing_thinking = ""
                    async for chunk in self.administrator.stream_routing_decision(
                        latest_message=latest_message,
                        available_agents=available_agents,
                        session=session,
                        conversation_history=conversation_messages,
                    ):
                        await self.send_event(chunk)

                        if chunk.role != admin_role:
                            # Role changed (e.g. assistant → tool), save accumulated
                            if routing_content or routing_thinking:
                                msg = {
                                    "role": admin_role,
                                    "content": routing_content,
                                    "thinking": routing_thinking if routing_thinking else None,
                                    "agent_id": admin_id if admin_role == "assistant" else None,
                                    "name": admin_name,
                                    "raw_input": session.last_raw_input if admin_role == "assistant" else None,
                                    "raw_output": session.last_raw_output if admin_role == "assistant" else None,
                                }
                                messages_to_save.append(msg)
                                self._accumulated_messages.append(msg)
                            admin_role = chunk.role
                            admin_name = chunk.name or ADMINISTRATOR_NAME
                            routing_content = chunk.content
                            routing_thinking = chunk.thinking or ""
                        else:
                            routing_content += chunk.content
                            if chunk.thinking:
                                routing_thinking += chunk.thinking

                    # Save final accumulated content
                    if routing_content or routing_thinking:
                        admin_route_msg = {
                            "role": admin_role,
                            "content": routing_content,
                            "thinking": routing_thinking if routing_thinking else None,
                            "agent_id": admin_id if admin_role == "assistant" else None,
                            "name": admin_name,
                            "raw_input": session.last_raw_input if admin_role == "assistant" else None,
                            "raw_output": session.last_raw_output if admin_role == "assistant" else None,
                        }
                        messages_to_save.append(admin_route_msg)
                        self._accumulated_messages.append(admin_route_msg)

                    # If still no routes after asking, break
                    if not session.pending_routes:
                        break

                # Pop next route from queue
                route = session.pending_routes.pop(0)

                if route["action"] == "route_to_user":
                    logger.debug(f"Routing to user: {route['reason']}")
                    break

                # Find the target agent
                target_name = route.get("agent_name", "")
                current_agent = agent_by_name.get(target_name.lower())
                if not current_agent:
                    logger.warning(f"Agent not found: {target_name}, skipping")
                    continue

                # Update session state
                session.set_current_agent(current_agent.id, current_agent.name)

                # Send agent switch event
                await self.send_event(AgentSwitchEvent(
                    from_agent_id=None,
                    from_agent_name=None,
                    to_agent_id=current_agent.id,
                    to_agent_name=current_agent.name,
                    reason=f"Turn {session.turn_count}: Processing with {current_agent.name}",
                ))

                # Create and run the agent
                agent = self._create_agent(current_agent)

                # Update context with agent's model
                agent_context.model_name = current_agent.model_name or event.model_name or DEFAULT_ADMIN_MODEL

                # Collect agent's response
                agent_response = ""
                agent_thinking = ""
                current_role = "assistant"
                current_name = current_agent.name  # Track name per group (agent name or tool name)
                chunk_content = ""
                chunk_thinking = ""
                raw_input_json = None  # Captured from agent's prepared messages on first chunk

                # Stream agent response
                async for chunk in agent.process(conversation_messages, agent_context):
                    # Capture raw input on first chunk (prepared messages are set before first yield)
                    if raw_input_json is None:
                        raw_input_json = json.dumps(
                            getattr(agent, 'last_prepared_messages', conversation_messages),
                            ensure_ascii=False, default=str,
                        )

                    # Attach agent voice reference for TTS
                    chunk.voice_reference = current_agent.voice_reference
                    # Send to client immediately
                    await self.send_event(chunk)

                    # Accumulate for logging and routing
                    if chunk.role != current_role:
                        # Role changed, save accumulated content
                        if chunk_content or chunk_thinking:
                            completed_msg = {
                                "role": current_role,
                                "content": chunk_content,
                                "thinking": chunk_thinking if chunk_thinking else None,
                                # agent_id only for assistant messages (for avatar/voice)
                                "agent_id": current_agent.id if current_role == "assistant" else None,
                                "name": current_name,
                                "raw_input": raw_input_json if current_role == "assistant" else None,
                                "raw_output": chunk_content if current_role == "assistant" else None,
                            }
                            messages_to_save.append(completed_msg)
                            self._accumulated_messages.append(completed_msg)
                            conversation_messages.append({
                                "role": current_role,
                                "content": chunk_content,
                                "agent_id": current_agent.id if current_role == "assistant" else None,
                                "name": current_name,
                            })
                        current_role = chunk.role
                        current_name = chunk.name or current_agent.name
                        chunk_content = chunk.content
                        chunk_thinking = chunk.thinking or ""
                    else:
                        chunk_content += chunk.content
                        if chunk.thinking:
                            chunk_thinking += chunk.thinking

                    # Update in-progress chunk for reconnect replay
                    self._current_chunk = {
                        "role": current_role,
                        "content": chunk_content,
                        "thinking": chunk_thinking if chunk_thinking else None,
                        "agent_id": current_agent.id if current_role == "assistant" else None,
                        "name": current_name,
                    }

                    # Track full response for routing
                    if chunk.role == "assistant":
                        agent_response += chunk.content
                        if chunk.thinking:
                            agent_thinking += chunk.thinking

                # Save final accumulated content
                if chunk_content or chunk_thinking:
                    completed_msg = {
                        "role": current_role,
                        "content": chunk_content,
                        "thinking": chunk_thinking if chunk_thinking else None,
                        "agent_id": current_agent.id if current_role == "assistant" else None,
                        "name": current_name,
                        "raw_input": raw_input_json if current_role == "assistant" else None,
                        "raw_output": chunk_content if current_role == "assistant" else None,
                    }
                    messages_to_save.append(completed_msg)
                    self._accumulated_messages.append(completed_msg)
                    conversation_messages.append({
                        "role": current_role,
                        "content": chunk_content,
                        "agent_id": current_agent.id if current_role == "assistant" else None,
                        "name": current_name,
                    })

                # Agent turn finished, clear in-progress chunk
                self._current_chunk = None

            # ========================================
            # CLEANUP AND PERSISTENCE
            # ========================================

            # Persist messages to DB
            await self._save_messages(messages_to_save, frame_id)

            # Update timestamps
            self._update_timestamps(frame_id, conversation_id)

            # Mark task as done and send done event
            self._current_chunk = None
            self._task_done = True
            await self.send_event(DoneEvent(
                conversation_id=conversation_id,
                frame_id=frame_id,
            ))

        except asyncio.CancelledError:
            logger.debug("Orchestration cancelled by user")
        except WebSocketDisconnect:
            raise
        except Exception as e:
            logger.error(f"Orchestration failed: {e}", exc_info=True)
            await self.send_event(ErrorEvent(
                error=str(e),
                code="INTERNAL_ERROR",
            ))

    async def _setup_conversation(self, event: ChatRequestEvent) -> tuple[int, int, list, str, str]:
        """Setup conversation, frame, and system messages.

        Returns:
            Tuple of (conversation_id, frame_id, system_messages, user_system_prompt, preferred_name)
        """
        with get_session() as session:
            conv_repo = ConversationRepository(session)
            frame_repo = FrameRepository(session)
            user_repo = UserRepository(session)

            # Get user for preferences
            user = user_repo.get_by_id(self.user_id)
            if not user:
                raise ValueError("User not found")

            # Create or get conversation
            if event.conversation_id is None:
                # Use first message as title (truncated)
                title = (event.text[:80] + "...") if len(event.text) > 80 else event.text
                conversation = conv_repo.create_conversation(self.user_id, title=title)
                conversation_id = conversation.id
            else:
                conversation_id = event.conversation_id

            # Get or create frame
            frame = frame_repo.get_latest_by_conversation(conversation_id)
            if not frame:
                frame = frame_repo.create_frame(conversation_id)
            frame_id = frame.id

            # Get user preferences
            system_prompt, preferred_name = user_repo.get_preferences(user)

        # Build system messages
        system_messages = build_system_messages(system_prompt, preferred_name)

        return conversation_id, frame_id, system_messages, system_prompt, preferred_name or ""

    def _load_user_agents(self) -> List[AgentConfig]:
        """Load all agents for the current user."""
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agents = agent_repo.list_by_user(self.user_id)

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

    def _get_agent_config(self, agent_id: int, agents: List[AgentConfig]) -> Optional[AgentConfig]:
        """Get agent config by ID from list."""
        for agent in agents:
            if agent.id == agent_id:
                return agent
        return None

    def _create_agent(self, config: AgentConfig) -> BaseAgent:
        """Create an agent instance from config."""
        return SimpleAgent(config, tool_registry)

    def _update_timestamps(self, frame_id: int, conversation_id: int):
        """Update frame and conversation timestamps."""
        with get_session() as session:
            frame_repo = FrameRepository(session)
            conv_repo = ConversationRepository(session)

            frame = frame_repo.get_by_id(frame_id)
            if frame:
                frame_repo.update_timestamp(frame)

            conversation = conv_repo.get_by_id(conversation_id)
            if conversation:
                conv_repo.update_timestamp(conversation)

    async def _handle_approval_response(self, event: ToolApprovalResponseEvent):
        """Handle tool approval response from client."""
        if event.approval_id in self.pending_approvals:
            future = self.pending_approvals[event.approval_id]
            if not future.done():
                future.set_result(event)

    async def _handle_cancel(self):
        """Handle cancel request."""
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()

    async def _handle_vision_start(self, event: VisionStartEvent):
        """Initialize vision processor for frame-by-frame processing."""
        await self._handle_vision_stop()

        self._vision_processor = VisionProcessor(
            self.user_id,
            enable_face=event.enable_face,
            enable_pose=event.enable_pose,
            enable_hands=event.enable_hands,
        )
        logger.info("Vision processing started for user %d", self.user_id)

    async def _handle_vision_frame(self, event: VisionFrameEvent):
        """Process a single webcam frame from the frontend."""
        if not self._vision_processor:
            return

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, self._vision_processor.process_frame, event.frame
        )

        if result:
            await self.send_event(VisionResultEvent(
                faces=result.get("faces", []),
                gestures=result.get("gestures", []),
            ))

    async def _handle_vision_stop(self):
        """Stop vision processing."""
        self._vision_processor = None
        logger.debug("Vision processing stopped for user %d", self.user_id)

    async def send_event(self, event: BaseEvent):
        """Send event to client (silently fails if disconnected)."""
        try:
            if self.websocket.client_state.name == "CONNECTED":
                await self.websocket.send_json(event.to_dict())
        except Exception as e:
            logger.debug(f"Failed to send WebSocket event: {e}")

    async def replace_websocket(self, websocket: WebSocket):
        """Replace WebSocket and replay accumulated state."""
        self.websocket = websocket

        if not self._accumulated_messages and not self._current_chunk:
            return

        conv_id = self._task_conversation_id or 0
        frame_id = self._task_frame_id or 0

        logger.debug(f"Replaying {len(self._accumulated_messages)} accumulated messages on reconnect")

        # Replay each accumulated message as a complete StreamChunkEvent
        for msg in self._accumulated_messages:
            event = StreamChunkEvent(
                content=msg["content"],
                thinking=msg.get("thinking"),
                role=msg["role"],
                agent_id=msg.get("agent_id"),
                name=msg.get("name"),
                conversation_id=conv_id,
                frame_id=frame_id,
            )
            try:
                await self.websocket.send_json(event.to_dict())
            except Exception:
                return

        # Send in-progress chunk if agent is still generating
        if self._current_chunk:
            event = StreamChunkEvent(
                content=self._current_chunk["content"],
                thinking=self._current_chunk.get("thinking"),
                role=self._current_chunk["role"],
                agent_id=self._current_chunk.get("agent_id"),
                name=self._current_chunk.get("name"),
                conversation_id=conv_id,
                frame_id=frame_id,
            )
            try:
                await self.websocket.send_json(event.to_dict())
            except Exception:
                return

        # If task already done, send DoneEvent
        if self._task_done:
            done = DoneEvent(conversation_id=conv_id, frame_id=frame_id)
            try:
                await self.websocket.send_json(done.to_dict())
            except Exception:
                pass

    async def request_tool_approval(
        self,
        request: ToolApprovalRequestEvent,
    ) -> ToolApprovalResponseEvent:
        """Request tool approval and wait for response.

        Args:
            request: Approval request event

        Returns:
            Approval response event
        """
        # Create future for this approval
        future = asyncio.get_event_loop().create_future()
        self.pending_approvals[request.approval_id] = future

        # Send approval request
        await self.send_event(request)

        # Wait for response (with timeout)
        try:
            response = await asyncio.wait_for(future, timeout=300.0)  # 5 min timeout
            return response
        except asyncio.TimeoutError:
            return ToolApprovalResponseEvent(
                approval_id=request.approval_id,
                approved=False,
            )
        finally:
            if request.approval_id in self.pending_approvals:
                del self.pending_approvals[request.approval_id]

    def _load_context_messages(self, conversation_id: int, frame_id: int) -> list:
        """Load context messages from database.

        Includes speaker name so _prepare_messages() can correctly map
        roles (assistant=self, user=others) and add speaker prefixes.
        """
        with get_session() as session:
            msg_repo = MessageRepository(session)
            messages = msg_repo.get_by_frame(frame_id, limit=1000)

            result = []
            for msg in messages:
                entry = {
                    "role": msg.role,
                    "content": msg.message,
                }
                if msg.name:
                    entry["name"] = msg.name
                if msg.agent_id:
                    entry["agent_id"] = msg.agent_id
                result.append(entry)
            return result

    def _load_agent(self, agent_id: int) -> BaseAgent:
        """Load agent from database."""
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agent = agent_repo.get_by_user_and_id(self.user_id, agent_id)

            if not agent:
                raise ValueError(f"Agent not found: {agent_id}")

            config = AgentConfig(
                id=agent.id,
                name=agent.name,
                system_prompt=agent.system_prompt or "",
                voice_reference=agent.voice_reference,
                avatar_uuid=agent.avatar_uuid,
                model_name=agent.model_name,
                tools=agent.tools or [],
                think=agent.think,
            )

            return BaseAgent.create_from_config(config, tool_registry)

    async def _save_messages(self, messages: list, frame_id: int):
        """Save messages to database."""
        with get_session() as session:
            msg_repo = MessageRepository(session)

            for msg in messages:
                msg_repo.create_message(
                    role=msg["role"],
                    message=msg["content"],
                    frame_id=frame_id,
                    thinking=msg.get("thinking"),
                    agent_id=msg.get("agent_id"),
                    name=msg.get("name"),
                    raw_input=msg.get("raw_input"),
                    raw_output=msg.get("raw_output"),
                )
