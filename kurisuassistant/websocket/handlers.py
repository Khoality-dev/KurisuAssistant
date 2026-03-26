"""WebSocket session handlers with turn-based orchestration."""

import asyncio
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from fastapi import WebSocket

from .events import (
    EventType,
    BaseEvent,
    ConnectedEvent,
    ChatRequestEvent,
    ToolApprovalRequestEvent,
    ToolApprovalResponseEvent,
    ToolCallRequestEvent,
    StreamChunkEvent,
    DoneEvent,
    ErrorEvent,
    CancelEvent,
    AgentSwitchEvent,
    VisionStartEvent,
    VisionFrameEvent,
    VisionStopEvent,
    VisionResultEvent,
    ClientToolsRegisterEvent,
    ToolCallResponseEvent,
    MediaPlayEvent,
    MediaPauseEvent,
    MediaResumeEvent,
    MediaSkipEvent,
    MediaStopEvent,
    MediaQueueAddEvent,
    MediaQueueRemoveEvent,
    MediaVolumeEvent,
    MediaErrorEvent,
    parse_event,
)
from kurisuassistant.agents.base import AgentConfig, AgentContext, BaseAgent, SimpleAgent
from kurisuassistant.tools import tool_registry
from kurisuassistant.tools.routing import RouteToTool, parse_route_result
from kurisuassistant.media import get_media_player
from kurisuassistant.vision import VisionProcessor
from sqlalchemy import desc
from kurisuassistant.db.models import Frame
from kurisuassistant.db.repositories import (
    AgentRepository,
    ConversationRepository,
    FrameRepository,
    MessageRepository,
    UserRepository,
)
from kurisuassistant.db.service import get_db_service
from kurisuassistant.utils.prompts import build_system_messages

logger = logging.getLogger(__name__)

# Default configuration
HEARTBEAT_INTERVAL = 30  # seconds between server pings
HEARTBEAT_TIMEOUT = 10   # seconds to wait for pong before closing
DEFAULT_MAX_TURNS = 10
ADMINISTRATOR_NAME = "Administrator"  # Reserved agent name for routing
FRAME_IDLE_THRESHOLD_MINUTES = int(os.getenv("FRAME_IDLE_THRESHOLD_MINUTES", "30"))


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
        self._send_lock = asyncio.Lock()

        # Task metadata for ConnectedEvent state
        self._task_conversation_id: Optional[int] = None
        self._task_frame_id: Optional[int] = None
        self._task_done: bool = False

        # Heartbeat
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._last_pong_time: float = 0

        # Client-side MCP tools
        self._client_tools: List[Dict] = []
        self._client_tool_names: set = set()
        self._pending_tool_calls: Dict[str, asyncio.Future] = {}

        # Vision processing
        self._vision_processor: Optional[VisionProcessor] = None
        self._vision_config: Optional[dict] = None

    async def run(self):
        """Main handler loop - receives and processes events."""
        from fastapi import WebSocketDisconnect
        import time

        ws = self.websocket
        self._last_pong_time = time.monotonic()
        my_heartbeat = asyncio.create_task(self._heartbeat_loop(ws))
        self._heartbeat_task = my_heartbeat

        try:
            while True:
                try:
                    data = await ws.receive_json()
                    msg_type = data.get("type")
                    if msg_type == "pong":
                        self._last_pong_time = time.monotonic()
                        continue
                    event = parse_event(data)
                    await self._handle_event(event)
                except WebSocketDisconnect:
                    raise
                except RuntimeError:
                    # WebSocket closed (e.g. heartbeat timeout) — treat as disconnect
                    raise WebSocketDisconnect()
                except Exception as e:
                    logger.error(f"Error handling WebSocket event: {e}", exc_info=True)
                    await self.send_event(ErrorEvent(
                        error=str(e),
                        code="INTERNAL_ERROR",
                    ))
        finally:
            my_heartbeat.cancel()
            # Only clear the shared reference if it's still ours (not replaced by a newer run())
            if self._heartbeat_task is my_heartbeat:
                self._heartbeat_task = None

    async def _heartbeat_loop(self, ws: WebSocket):
        """Periodically ping the client; close if no pong received in time.

        Operates on the specific WebSocket passed at creation time.
        Auto-stops if the handler's websocket has been replaced (reconnect).
        """
        import time
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                # Stop if websocket was replaced by a reconnect
                if self.websocket is not ws:
                    return
                try:
                    async with self._send_lock:
                        state = ws.client_state.name
                        if state == "CONNECTED":
                            await ws.send_json({"type": "ping"})
                        else:
                            return
                except Exception:
                    return

                # Wait for pong
                await asyncio.sleep(HEARTBEAT_TIMEOUT)
                if self.websocket is not ws:
                    return
                if time.monotonic() - self._last_pong_time > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT:
                    logger.warning("Heartbeat timeout — closing WebSocket for user %d", self.user_id)
                    try:
                        await ws.close(code=4002, reason="Heartbeat timeout")
                    except Exception:
                        pass
                    return
        except asyncio.CancelledError:
            pass

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
        elif isinstance(event, ClientToolsRegisterEvent):
            self._handle_client_tools_register(event)
        elif isinstance(event, ToolCallResponseEvent):
            self._handle_tool_call_response(event)
        elif isinstance(event, (MediaPlayEvent, MediaPauseEvent, MediaResumeEvent,
                                MediaSkipEvent, MediaStopEvent, MediaQueueAddEvent,
                                MediaQueueRemoveEvent, MediaVolumeEvent)):
            await self._handle_media_event(event)

    async def _handle_chat_request(self, event: ChatRequestEvent):
        """Handle incoming chat request."""
        # Cancel any existing task (force interrupt)
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                pass

        self.current_task = asyncio.create_task(
            self._run_chat(event)
        )

    async def _run_chat(self, event: ChatRequestEvent):
        """Run unified chat processing with Administrator routing.

        Flow:
        1. Setup conversation/frame (same as before)
        2. Load all enabled agents (system + user's)
        3. Find Administrator agent (is_system=True, name="Administrator")
        4. Start with Administrator, loop with routing:
           - Administrator sees full history + route_to tool
           - Sub-agents see their system prompt + route_to message only
           - After sub-agent finishes, control returns to Administrator
        5. Send DoneEvent
        """
        from fastapi import WebSocketDisconnect
        try:
            # Setup conversation/frame
            conversation_id, frame_id, system_messages, user_system_prompt, preferred_name, old_frame_id, ollama_url, gemini_api_key, nvidia_api_key, summary_model, summary_provider, unsummarized_ids, context_size = await self._setup_conversation(event)

            # Reset task state
            self._task_conversation_id = conversation_id
            self._task_frame_id = frame_id
            self._task_done = False

            # Load all enabled agents (system + user's)
            all_agents = self._load_enabled_agents()

            # Separate Administrator from sub-agents
            admin_agent = None
            sub_agents = []
            for agent in all_agents:
                if agent.is_system and agent.name == ADMINISTRATOR_NAME:
                    admin_agent = agent
                else:
                    sub_agents.append(agent)

            # Submit background tasks for old/unsummarized frames
            fids = ([old_frame_id] if old_frame_id else []) + unsummarized_ids
            if summary_model and fids:
                import kurisuassistant.workers as workers
                summary_api_key = gemini_api_key if summary_provider == "gemini" else nvidia_api_key if summary_provider == "nvidia" else None
                for fid in fids:
                    workers.submit(workers.SummarizeFrameTask(frame_id=fid, model_name=summary_model, api_url=ollama_url, provider_type=summary_provider, api_key=summary_api_key))

            if not admin_agent:
                # No Administrator agent — fall back: if only one sub-agent, use it directly
                if not sub_agents:
                    await self.send_event(ErrorEvent(
                        error="No agents available. Please create at least one agent.",
                        code="NO_AGENTS",
                    ))
                    return
                # Use first sub-agent (or the one specified by event.agent_id) directly
                admin_agent = None  # Will skip routing loop

            if not sub_agents:
                await self.send_event(ErrorEvent(
                    error="No agents available. Please create at least one agent.",
                    code="NO_AGENTS",
                ))
                return

            # Save user images to disk
            image_uuids = []
            if event.images:
                from kurisuassistant.utils.images import save_image_from_base64
                for b64 in event.images:
                    try:
                        image_uuids.append(save_image_from_base64(b64, self.user_id))
                    except Exception as e:
                        logger.warning(f"Failed to save image: {e}")

            # Load context messages
            context_messages = self._load_context_messages(conversation_id, frame_id)

            # Build messages
            user_message = {"role": "user", "content": event.text}
            if image_uuids:
                user_message["images"] = image_uuids
            conversation_messages = system_messages + context_messages + [user_message]

            # Save user message immediately
            self._save_message(user_message, frame_id)

            # Stream image UUIDs to client
            if image_uuids:
                await self.send_event(StreamChunkEvent(
                    content="", role="user", images=image_uuids,
                    conversation_id=conversation_id, frame_id=frame_id))

            # Build agent lookup (for routing)
            agent_by_name = {a.name.lower(): a for a in sub_agents}

            # Create base agent context (model_name updated per agent in loop)
            agent_context = AgentContext(
                user_id=self.user_id,
                conversation_id=conversation_id,
                frame_id=frame_id,
                model_name=event.model_name,  # Updated per agent in routing loop
                handler=self,
                available_agents=sub_agents,
                user_system_prompt=user_system_prompt,
                preferred_name=preferred_name,
                api_url=ollama_url,
                gemini_api_key=gemini_api_key,
                nvidia_api_key=nvidia_api_key,
                client_tools=self._client_tools,
                client_tool_callback=self._execute_client_tool,
                images=event.images if event.images else None,
                context_size=context_size,
            )

            # ========================================
            # ROUTING LOOP
            # ========================================
            # If no Administrator, run single agent directly (no routing)
            if not admin_agent:
                target = self._get_agent_config(event.agent_id, sub_agents) or sub_agents[0]
                await self._run_agent_turn(
                    target, conversation_messages, conversation_messages,
                    agent_context, frame_id, event,
                )
            else:
                # Build route_to tool with available agent names + descriptions
                route_tool_agents = [
                    {"name": a.name, "description": a.description or a.system_prompt[:100] or "General assistant"}
                    for a in sub_agents
                ]
                route_to_tool = RouteToTool(available_agents=route_tool_agents)

                current_agent = admin_agent
                route_message = None  # Message from route_to, or None for full history

                MAX_ROUTING_TURNS = 10
                prev_agent_name = None

                for _turn in range(MAX_ROUTING_TURNS):
                    is_admin = (current_agent.is_system and current_agent.name == ADMINISTRATOR_NAME)

                    # --- Build messages for this agent ---
                    if is_admin:
                        # Administrator sees full conversation history
                        agent_messages = list(conversation_messages)
                    else:
                        # Sub-agent gets only the route_to message as a user message
                        agent_messages = [{"role": "user", "content": route_message or event.text}]

                    # --- Register route_to tool for Administrator only ---
                    if is_admin:
                        tool_registry.register(route_to_tool)

                    try:
                        # Send agent switch event
                        await self.send_event(AgentSwitchEvent(
                            from_agent_id=None,
                            from_agent_name=prev_agent_name,
                            to_agent_id=current_agent.id,
                            to_agent_name=current_agent.name,
                            reason=f"Processing with {current_agent.name}",
                        ))

                        # Update context model for this agent
                        agent_context.model_name = current_agent.model_name or event.model_name

                        # Create and run agent
                        agent = self._create_agent(current_agent)

                        # Stream and collect response, save messages
                        route_result, agent_final_content = await self._stream_and_save_agent(
                            agent=agent,
                            agent_config=current_agent,
                            messages=agent_messages,
                            context=agent_context,
                            frame_id=frame_id,
                            conversation_messages=conversation_messages,
                            is_admin=is_admin,
                        )
                    finally:
                        if is_admin:
                            tool_registry.unregister("route_to")

                    prev_agent_name = current_agent.name

                    # --- Check routing result ---
                    if route_result:
                        # route_to was called — switch to target agent
                        target_name = route_result["agent_name"]
                        target_agent = agent_by_name.get(target_name.lower())
                        if not target_agent:
                            logger.warning(f"Route target agent not found: {target_name}")
                            break
                        current_agent = target_agent
                        route_message = route_result["message"]
                        continue

                    # No route_to called — done
                    break

            # ========================================
            # CLEANUP
            # ========================================
            self._update_timestamps(frame_id, conversation_id)

            self._task_done = True
            await self.send_event(DoneEvent(
                conversation_id=conversation_id,
                frame_id=frame_id,
            ))

        except asyncio.CancelledError:
            logger.debug("Chat task cancelled by user")
        except WebSocketDisconnect:
            raise
        except Exception as e:
            logger.error(f"Chat task failed: {e}", exc_info=True)
            await self.send_event(ErrorEvent(
                error=str(e),
                code="INTERNAL_ERROR",
            ))

    async def _stream_and_save_agent(
        self,
        agent: BaseAgent,
        agent_config: AgentConfig,
        messages: List[Dict],
        context: AgentContext,
        frame_id: int,
        conversation_messages: List[Dict],
        is_admin: bool,
    ) -> tuple[Optional[Dict], str]:
        """Stream an agent's response, save messages to DB, and detect route_to calls.

        Args:
            agent: Agent instance to run
            agent_config: Agent configuration
            messages: Messages to pass to agent.process()
            context: Agent context
            frame_id: Current frame ID for message saving
            conversation_messages: Full conversation history (mutated — sub-agent responses appended)
            is_admin: Whether this is the Administrator agent

        Returns:
            Tuple of (route_result, final_content):
            - route_result: Dict with 'agent_name' and 'message' if route_to was called, else None
            - final_content: The full assistant text content from this agent turn
        """
        current_role = "assistant"
        current_name = agent_config.name
        chunk_content = ""
        chunk_thinking = ""
        current_images = []
        raw_input_json = None
        current_tool_args_json = None
        current_tool_args = None
        route_result = None
        final_assistant_content = ""

        async for chunk in agent.process(messages, context):
            # Capture raw input on first chunk
            if raw_input_json is None:
                raw_input_json = json.dumps(
                    getattr(agent, 'last_prepared_messages', messages),
                    ensure_ascii=False, default=str,
                )

            # Attach agent voice reference for TTS
            chunk.voice_reference = agent_config.voice_reference
            await self.send_event(chunk)

            # Track tool images
            if chunk.images:
                current_images.extend(chunk.images)

            # Check tool results for route_to
            if chunk.role == "tool" and chunk.name == "route_to":
                parsed = parse_route_result(chunk.content)
                if parsed:
                    route_result = parsed

            # Save completed message on role change
            if chunk.role != current_role:
                if chunk_content or chunk_thinking:
                    raw_in = raw_input_json if current_role == "assistant" else current_tool_args_json
                    completed_msg = {
                        "role": current_role,
                        "content": chunk_content,
                        "thinking": chunk_thinking if chunk_thinking else None,
                        "agent_id": agent_config.id if current_role == "assistant" else None,
                        "name": current_name,
                        "raw_input": raw_in,
                        "raw_output": chunk_content if current_role == "assistant" else None,
                        "images": current_images if current_images else None,
                        "model_name": chunk.model_name if current_role == "assistant" else None,
                        "provider_type": chunk.provider_type if current_role == "assistant" else None,
                        "tool_args": current_tool_args if current_role == "tool" else None,
                    }
                    self._save_message(completed_msg, frame_id)
                    # Add to conversation history so Administrator sees sub-agent responses
                    conversation_messages.append({
                        "role": current_role,
                        "content": chunk_content,
                        "agent_id": agent_config.id if current_role == "assistant" else None,
                        "name": current_name,
                    })
                    if current_role == "assistant":
                        final_assistant_content += chunk_content
                current_role = chunk.role
                current_name = chunk.name or agent_config.name
                chunk_content = chunk.content
                chunk_thinking = chunk.thinking or ""
                current_images = []
                current_tool_args_json = json.dumps(chunk.tool_args, ensure_ascii=False) if chunk.tool_args else None
                current_tool_args = chunk.tool_args if chunk.tool_args else None
            else:
                chunk_content += chunk.content
                if chunk.thinking:
                    chunk_thinking += chunk.thinking

        # Save final message
        if chunk_content or chunk_thinking:
            raw_in = raw_input_json if current_role == "assistant" else current_tool_args_json
            completed_msg = {
                "role": current_role,
                "content": chunk_content,
                "thinking": chunk_thinking if chunk_thinking else None,
                "agent_id": agent_config.id if current_role == "assistant" else None,
                "name": current_name,
                "raw_input": raw_in,
                "raw_output": chunk_content if current_role == "assistant" else None,
                "images": current_images if current_images else None,
                "model_name": chunk.model_name if current_role == "assistant" else None,
                "provider_type": chunk.provider_type if current_role == "assistant" else None,
                "tool_args": current_tool_args if current_role == "tool" else None,
            }
            self._save_message(completed_msg, frame_id)
            conversation_messages.append({
                "role": current_role,
                "content": chunk_content,
                "agent_id": agent_config.id if current_role == "assistant" else None,
                "name": current_name,
            })
            if current_role == "assistant":
                final_assistant_content += chunk_content

        return route_result, final_assistant_content

    async def _run_agent_turn(
        self,
        agent_config: AgentConfig,
        messages: List[Dict],
        conversation_messages: List[Dict],
        context: AgentContext,
        frame_id: int,
        event: ChatRequestEvent,
    ):
        """Run a single agent turn (no routing, used as fallback when no Administrator).

        This preserves the original single-agent behavior for when the Administrator
        agent is not available.
        """
        context.model_name = agent_config.model_name or event.model_name
        agent = self._create_agent(agent_config)

        await self._stream_and_save_agent(
            agent=agent,
            agent_config=agent_config,
            messages=messages,
            context=context,
            frame_id=frame_id,
            conversation_messages=conversation_messages,
            is_admin=False,
        )

    async def _setup_conversation(self, event: ChatRequestEvent) -> tuple[int, int, list, str, str, int | None, str | None, str | None, list[int]]:
        """Setup conversation, frame, and system messages.

        If the latest frame has been idle longer than FRAME_IDLE_THRESHOLD_MINUTES,
        a new frame is created and the old frame ID is returned for summarization.
        Also finds older frames missing summaries for backfill.

        Returns:
            Tuple of (conversation_id, frame_id, system_messages, user_system_prompt,
                       preferred_name, old_frame_id, ollama_url, summary_model, unsummarized_ids, context_size)
        """
        db = get_db_service()

        def _do_setup(session):
            from kurisuassistant.db.models import Message
            from sqlalchemy import func

            conv_repo = ConversationRepository(session)
            frame_repo = FrameRepository(session)
            msg_repo = MessageRepository(session)
            user_repo = UserRepository(session)

            user = user_repo.get_by_id(self.user_id)
            if not user:
                raise ValueError("User not found")

            ollama_url = user.ollama_url
            gemini_api_key = getattr(user, 'gemini_api_key', None)
            nvidia_api_key = getattr(user, 'nvidia_api_key', None)
            summary_model = user.summary_model
            summary_provider = getattr(user, 'summary_provider', 'ollama') or 'ollama'
            context_size = user.context_size

            if event.conversation_id is None:
                title = (event.text[:80] + "...") if len(event.text) > 80 else event.text
                conversation = conv_repo.create_conversation(self.user_id, title=title)
                conversation_id = conversation.id
            else:
                conversation_id = event.conversation_id

            old_frame_id = None
            frame = frame_repo.get_latest_by_conversation(conversation_id)
            if not frame:
                frame = frame_repo.create_frame(conversation_id)
            else:
                idle_threshold = timedelta(minutes=FRAME_IDLE_THRESHOLD_MINUTES)
                last_activity = frame.updated_at or frame.created_at
                if datetime.utcnow() - last_activity > idle_threshold:
                    msg_count = msg_repo.count_by_frame(frame.id)
                    if msg_count > 0:
                        old_frame_id = frame.id
                    frame = frame_repo.create_frame(conversation_id)
            frame_id = frame.id

            unsummarized = (
                session.query(Frame.id)
                .outerjoin(Message, Frame.id == Message.frame_id)
                .filter(
                    Frame.conversation_id == conversation_id,
                    Frame.id != frame_id,
                    Frame.summary.is_(None),
                )
                .group_by(Frame.id)
                .having(func.count(Message.id) > 0)
                .all()
            )
            unsummarized_ids = [row.id for row in unsummarized]

            system_prompt, preferred_name = user_repo.get_preferences(user)

            return (conversation_id, frame_id, system_prompt, preferred_name,
                    old_frame_id, ollama_url, gemini_api_key, nvidia_api_key, summary_model, summary_provider, unsummarized_ids, context_size)

        (conversation_id, frame_id, system_prompt, preferred_name,
         old_frame_id, ollama_url, gemini_api_key, nvidia_api_key, summary_model, summary_provider, unsummarized_ids, context_size) = await db.execute(_do_setup)

        system_messages = build_system_messages(system_prompt, preferred_name)

        return conversation_id, frame_id, system_messages, system_prompt, preferred_name or "", old_frame_id, ollama_url, gemini_api_key, nvidia_api_key, summary_model, summary_provider, unsummarized_ids, context_size

    def _load_enabled_agents(self) -> List[AgentConfig]:
        """Load system agents + user's enabled agents."""
        db = get_db_service()

        def _query(session):
            agents = AgentRepository(session).list_enabled_for_user(self.user_id)
            return [self._agent_to_config(agent) for agent in agents]

        return db.execute_sync(_query)

    @staticmethod
    def _agent_to_config(agent) -> AgentConfig:
        """Convert a DB Agent model to AgentConfig, resolving persona relationships."""
        return AgentConfig(
            id=agent.id,
            name=agent.name,
            description=agent.description or "",
            system_prompt=agent.system_prompt or "",
            model_name=agent.model_name,
            provider_type=getattr(agent, 'provider_type', 'ollama') or 'ollama',
            excluded_tools=agent.excluded_tools,
            think=agent.think,
            memory=agent.memory,
            memory_enabled=agent.memory_enabled,
            enabled=agent.enabled,
            is_system=agent.is_system,
            persona_id=agent.persona.id if agent.persona else None,
            persona_name=agent.persona.name if agent.persona else agent.name,
            persona_system_prompt=agent.persona.system_prompt if agent.persona else "",
            voice_reference=agent.persona.voice_reference if agent.persona else None,
            avatar_uuid=agent.persona.avatar_uuid if agent.persona else None,
            preferred_name=agent.persona.preferred_name if agent.persona else None,
            trigger_word=agent.persona.trigger_word if agent.persona else None,
        )

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
        db = get_db_service()

        def _update(session):
            frame_repo = FrameRepository(session)
            conv_repo = ConversationRepository(session)
            frame = frame_repo.get_by_id(frame_id)
            if frame:
                frame_repo.update_timestamp(frame)
            conversation = conv_repo.get_by_id(conversation_id)
            if conversation:
                conv_repo.update_timestamp(conversation)

        db.execute_sync(_update)

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

        self._vision_config = {
            "enable_face": event.enable_face,
            "enable_pose": event.enable_pose,
            "enable_hands": event.enable_hands,
        }
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
        self._vision_config = None
        logger.debug("Vision processing stopped for user %d", self.user_id)

    # =============================================
    # Client-side tool management
    # =============================================

    def _handle_client_tools_register(self, event: ClientToolsRegisterEvent):
        """Store tool schemas registered by the client."""
        self._client_tools = event.tools
        self._client_tool_names = {
            t.get("function", {}).get("name", "")
            for t in event.tools
            if t.get("function", {}).get("name")
        }
        logger.info(
            "Client registered %d tools for user %d: %s",
            len(self._client_tools),
            self.user_id,
            ", ".join(sorted(self._client_tool_names)),
        )

    def _handle_tool_call_response(self, event: ToolCallResponseEvent):
        """Resolve a pending client tool call Future."""
        future = self._pending_tool_calls.pop(event.request_id, None)
        if future and not future.done():
            if event.is_error:
                future.set_result(f"Client tool error: {event.content}")
            else:
                future.set_result(event.content)
        else:
            logger.warning(
                "Received tool_call_response for unknown/completed request_id=%s",
                event.request_id,
            )

    async def _execute_client_tool(self, tool_name: str, tool_args: Dict) -> str:
        """Forward a tool call to the client and await the result.

        Creates an asyncio.Future, sends a ToolCallRequestEvent to the client,
        and waits up to 120s for the client to respond with ToolCallResponseEvent.
        """
        import uuid as _uuid

        request_id = str(_uuid.uuid4())
        future = asyncio.get_event_loop().create_future()
        self._pending_tool_calls[request_id] = future

        await self.send_event(ToolCallRequestEvent(
            request_id=request_id,
            tool_name=tool_name,
            tool_args=tool_args,
        ))

        try:
            result = await asyncio.wait_for(future, timeout=120.0)
            return result
        except asyncio.TimeoutError:
            return f"Client tool '{tool_name}' timed out after 120s"
        finally:
            self._pending_tool_calls.pop(request_id, None)

    async def _handle_media_event(self, event: BaseEvent):
        """Handle media control events using the player registry."""
        try:
            player = get_media_player(self.user_id, self.send_event)

            if isinstance(event, MediaPlayEvent):
                await player.play(event.query)
            elif isinstance(event, MediaPauseEvent):
                await player.pause()
            elif isinstance(event, MediaResumeEvent):
                await player.resume()
            elif isinstance(event, MediaSkipEvent):
                await player.skip()
            elif isinstance(event, MediaStopEvent):
                await player.stop()
            elif isinstance(event, MediaQueueAddEvent):
                await player.add_to_queue(event.query)
            elif isinstance(event, MediaQueueRemoveEvent):
                player.remove_from_queue(event.index)
            elif isinstance(event, MediaVolumeEvent):
                player.set_volume(event.volume)
        except Exception as e:
            logger.error(f"Media event error: {e}", exc_info=True)
            await self.send_event(MediaErrorEvent(error=str(e)))

    async def send_event(self, event: BaseEvent):
        """Send event to client (silently fails if disconnected)."""
        event_type = event.type.value if hasattr(event.type, 'value') else event.type
        try:
            async with self._send_lock:
                state = self.websocket.client_state.name
                if state == "CONNECTED":
                    await self.websocket.send_json(event.to_dict())
                else:
                    logger.debug(f"WebSocket not connected (state={state}), dropping {event_type}")
        except Exception:
            logger.debug(f"Failed to send WebSocket event {event_type} (socket closed)")

    async def send_connected_state(self):
        """Send a ConnectedEvent with current server-side state snapshot."""
        from kurisuassistant.media.player import _players

        chat_active = self.current_task is not None and not self.current_task.done()

        # Media state
        media_state = None
        player = _players.get(self.user_id)
        if player:
            media_state = player.get_state()

        await self.send_event(ConnectedEvent(
            chat_active=chat_active,
            conversation_id=self._task_conversation_id if chat_active or self._task_done else None,
            frame_id=self._task_frame_id if chat_active or self._task_done else None,
            media_state=media_state,
            vision_active=self._vision_processor is not None,
            vision_config=self._vision_config,
        ))

    async def replace_websocket(self, websocket: WebSocket):
        """Replace WebSocket on reconnect (no replay — messages already in DB)."""
        self.websocket = websocket

        # Cancel old heartbeat (new run() will start a fresh one)
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None

        # Update media player's send callback to route through new socket
        get_media_player(self.user_id, self.send_event)

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
        """Load context messages from the last 2 frames.

        Includes the previous frame's messages (prefixed with a summary separator)
        plus the current frame's messages, giving the LLM more conversational context.
        """
        db = get_db_service()

        def _query(session):
            msg_repo = MessageRepository(session)

            frames = (
                session.query(Frame)
                .filter_by(conversation_id=conversation_id)
                .filter(Frame.id <= frame_id)
                .order_by(desc(Frame.created_at), desc(Frame.id))
                .limit(2)
                .all()
            )
            frames.reverse()

            result = []
            for frame in frames:
                if frame.id != frame_id and frame.summary:
                    result.append({
                        "role": "system",
                        "content": f"[Previous session summary]: {frame.summary}",
                    })

                messages = msg_repo.get_by_frame(frame.id, limit=1000)
                for msg in messages:
                    entry = {
                        "role": msg.role,
                        "content": msg.message,
                    }
                    if msg.name:
                        entry["name"] = msg.name
                    if msg.agent_id:
                        entry["agent_id"] = msg.agent_id
                    if msg.thinking:
                        entry["thinking"] = msg.thinking
                    result.append(entry)
            return result

        return db.execute_sync(_query)

    def _load_agent(self, agent_id: int) -> BaseAgent:
        """Load agent from database."""
        db = get_db_service()

        def _query(session):
            agent = AgentRepository(session).get_by_user_and_id(self.user_id, agent_id)
            if not agent:
                raise ValueError(f"Agent not found: {agent_id}")
            return self._agent_to_config(agent)

        config = db.execute_sync(_query)
        return BaseAgent.create_from_config(config, tool_registry)

    def _save_message(self, msg: dict, frame_id: int):
        """Save a single message to database immediately."""
        db = get_db_service()
        db.execute_sync(lambda s: MessageRepository(s).create_message(
            role=msg["role"],
            message=msg["content"],
            frame_id=frame_id,
            thinking=msg.get("thinking"),
            agent_id=msg.get("agent_id"),
            name=msg.get("name"),
            raw_input=msg.get("raw_input"),
            raw_output=msg.get("raw_output"),
            images=msg.get("images"),
            model_name=msg.get("model_name"),
            provider_type=msg.get("provider_type"),
            tool_args=msg.get("tool_args"),
        ))
