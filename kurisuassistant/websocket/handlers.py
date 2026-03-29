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
    ContextInfoEvent,
    CompactContextEvent,
    parse_event,
)
from kurisuassistant.agents.base import AgentConfig, AgentContext, BaseAgent, SimpleAgent
from kurisuassistant.tools import tool_registry
from kurisuassistant.tools.routing import RouteToTool, parse_route_result
from kurisuassistant.media import get_media_player
from kurisuassistant.vision import VisionProcessor
from sqlalchemy import desc
from kurisuassistant.db.models import Conversation, Frame, Message
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


def _sanitize_device_prefix(name: str) -> str:
    """Convert device name to a safe tool-name prefix (lowercase, alnum + underscore)."""
    import re
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


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

    def __init__(self, user_id: int):
        self.user_id = user_id
        self.pending_approvals: Dict[str, asyncio.Future] = {}
        self.current_task: Optional[asyncio.Task] = None
        self._send_lock = asyncio.Lock()

        # Task metadata for ConnectedEvent state
        self._task_conversation_id: Optional[int] = None
        self._task_frame_id: Optional[int] = None
        self._task_done: bool = False

        # Multi-device connections
        self._connections: Dict[str, WebSocket] = {}
        self._device_tools: Dict[str, List[Dict]] = {}
        self._device_tool_names: Dict[str, set] = {}
        self._active_device: Optional[str] = None

        # Client-side MCP tools (combined, rebuilt on registration changes)
        self._client_tools: List[Dict] = []
        self._client_tool_names: set = set()
        self._pending_tool_calls: Dict[str, asyncio.Future] = {}
        self._tool_device_map: Dict[str, tuple[str, str]] = {}

        # Message queue — new requests queued while agent is running
        self._message_queue: List[ChatRequestEvent] = []

        # Vision processing
        self._vision_processor: Optional[VisionProcessor] = None
        self._vision_config: Optional[dict] = None

    def add_connection(self, device_name: str, ws: WebSocket):
        self._connections[device_name] = ws
        if self._active_device is None or len(self._connections) == 1:
            self._active_device = device_name
        get_media_player(self.user_id, self.send_event)
        logger.info("Device '%s' connected for user %d (%d device(s))", device_name, self.user_id, len(self._connections))

    def remove_connection(self, device_name: str):
        self._connections.pop(device_name, None)
        self._device_tools.pop(device_name, None)
        self._device_tool_names.pop(device_name, None)
        self._rebuild_client_tools()
        for req_id, future in list(self._pending_tool_calls.items()):
            if not future.done():
                future.set_result(f"Device '{device_name}' disconnected")
        if self._active_device == device_name:
            self._active_device = next(iter(self._connections)) if self._connections else None
        logger.info("Device '%s' disconnected for user %d (%d device(s) remaining)", device_name, self.user_id, len(self._connections))

    def has_connections(self) -> bool:
        return bool(self._connections)

    def get_connected_device_names(self) -> List[str]:
        return list(self._connections.keys())

    async def handle_message(self, data: dict, device_name: str):
        try:
            event = parse_event(data)
            if isinstance(event, ChatRequestEvent) and device_name in self._connections:
                self._active_device = device_name
            await self._handle_event(event, device_name)
        except Exception as e:
            logger.error(f"Error handling WebSocket event: {e}", exc_info=True)
            await self._send_to_device(device_name, ErrorEvent(error=str(e), code="INTERNAL_ERROR"))

    async def _handle_event(self, event: BaseEvent, device_name: str = ""):
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
            self._handle_client_tools_register(event, device_name)
        elif isinstance(event, ToolCallResponseEvent):
            self._handle_tool_call_response(event)
        elif isinstance(event, CompactContextEvent):
            await self._handle_compact_context(event)
        elif isinstance(event, (MediaPlayEvent, MediaPauseEvent, MediaResumeEvent,
                                MediaSkipEvent, MediaStopEvent, MediaQueueAddEvent,
                                MediaQueueRemoveEvent, MediaVolumeEvent)):
            await self._handle_media_event(event)

    async def _handle_chat_request(self, event: ChatRequestEvent):
        """Handle incoming chat request, queuing if agent is busy."""
        if self.current_task and not self.current_task.done():
            # Agent is busy — queue the message for later
            self._message_queue.append(event)
            logger.debug("Queued message (queue size: %d)", len(self._message_queue))
            return

        self.current_task = asyncio.create_task(
            self._run_chat(event)
        )

    def _process_queue(self):
        """Process all queued messages as a single agent turn.

        Each message is saved as a separate user bubble in the DB,
        but the agent sees them all in one turn.
        """
        if not self._message_queue:
            return
        queued = list(self._message_queue)
        self._message_queue.clear()
        # First event drives the turn; extra messages are added to context
        primary = queued[0]
        extra = queued[1:] if len(queued) > 1 else []
        logger.debug("Processing %d queued messages as single turn", len(queued))
        self.current_task = asyncio.create_task(
            self._run_chat(primary, extra_messages=extra)
        )

    async def _run_chat(self, event: ChatRequestEvent, extra_messages: Optional[List] = None):
        """Run unified chat processing with Administrator routing.

        Args:
            event: Primary chat request event
            extra_messages: Additional queued ChatRequestEvents to include as user messages

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

            # Load context messages (compacted context + messages after watermark)
            compacted_context, compacted_up_to_id, context_messages = self._load_context_messages(conversation_id)

            # Build messages
            user_message = {"role": "user", "content": event.text}
            if image_uuids:
                user_message["images"] = image_uuids
            conversation_messages = system_messages + context_messages + [user_message]

            # Save user message immediately
            self._save_message(user_message, frame_id)

            # Add extra queued messages (each saved as separate bubble)
            if extra_messages:
                for extra_event in extra_messages:
                    extra_msg = {"role": "user", "content": extra_event.text}
                    # Save extra images
                    if extra_event.images:
                        from kurisuassistant.utils.images import save_image_from_base64
                        extra_imgs = []
                        for b64 in extra_event.images:
                            try:
                                extra_imgs.append(save_image_from_base64(b64, self.user_id))
                            except Exception as e:
                                logger.warning(f"Failed to save image: {e}")
                        if extra_imgs:
                            extra_msg["images"] = extra_imgs
                    self._save_message(extra_msg, frame_id)
                    conversation_messages.append(extra_msg)

            # Estimate tokens and compact if needed
            context_limit = context_size or 8192
            token_count = self._estimate_tokens(conversation_messages)

            if token_count > context_limit * 0.9 and summary_model:
                # Notify client that compaction is in progress
                await self.send_event(ContextInfoEvent(
                    conversation_id=conversation_id, compacting=True,
                ))
                summary_api_key_for_compact = gemini_api_key if summary_provider == "gemini" else nvidia_api_key if summary_provider == "nvidia" else None
                compacted_context = await asyncio.to_thread(
                    self._compact_context,
                    conversation_id, context_limit, conversation_messages,
                    summary_model, ollama_url, summary_provider, summary_api_key_for_compact,
                )
                # Reload — now only the current user message remains as recent
                compacted_context, compacted_up_to_id, context_messages = self._load_context_messages(conversation_id)
                conversation_messages = system_messages + context_messages + [user_message]
                token_count = self._estimate_tokens(conversation_messages)
                # Notify client compaction done with updated watermark
                await self.send_event(ContextInfoEvent(
                    conversation_id=conversation_id,
                    compacted_up_to_id=compacted_up_to_id,
                    compacted_context=compacted_context,
                ))

            # Store for streaming token updates
            self._initial_token_count = token_count

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
                compacted_context=compacted_context,
            )

            # ========================================
            # ROUTING LOOP
            # ========================================
            self._response_word_count = 0

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

                    if not is_admin:
                        # Sub-agent finished — return to Administrator for final response
                        current_agent = admin_agent
                        route_message = None
                        continue

                    # Administrator finished without routing — done
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

            # Process next queued message if any
            self._process_queue()

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
            # Process next queued message even after error
            self._process_queue()

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
            # Accumulate response word count for token estimation (all content + thinking)
            if chunk.content:
                self._response_word_count += len(chunk.content.split())
            if chunk.thinking:
                self._response_word_count += len(chunk.thinking.split())

            # Attach agent metadata and running token count for client display
            chunk.voice_reference = agent_config.voice_reference
            chunk.persona_name = agent_config.persona_name or None
            chunk.token_count = self._initial_token_count + int(self._response_word_count * 1.3)
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

        # Capture raw input after processing — includes all intermediate
        # assistant + tool messages from the tool loop
        raw_input_json = json.dumps(
            getattr(agent, 'last_prepared_messages', messages),
            ensure_ascii=False, default=str,
        )

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
        """Handle cancel request — cancels current task and clears queue."""
        self._message_queue.clear()
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()

    async def _handle_compact_context(self, event: CompactContextEvent):
        """Handle manual /compact command."""
        conversation_id = event.conversation_id
        if not conversation_id:
            return

        # Load user preferences for summary model
        db = get_db_service()
        def _get_prefs(session):
            user = UserRepository(session).get_by_id(self.user_id)
            if not user:
                return None, None, None, None, None
            return (
                user.summary_model,
                getattr(user, 'summary_provider', 'ollama'),
                user.ollama_url,
                getattr(user, 'gemini_api_key', None),
                getattr(user, 'nvidia_api_key', None),
            )
        summary_model, summary_provider, ollama_url, gemini_api_key, nvidia_api_key = db.execute_sync(_get_prefs)

        if not summary_model:
            await self.send_event(ErrorEvent(error="No summary model configured.", code="NO_SUMMARY_MODEL"))
            return

        # Load current context
        compacted_context, compacted_up_to_id, context_messages = self._load_context_messages(conversation_id)

        if not context_messages:
            return

        context_limit = 8192  # default
        def _get_ctx(session):
            user = UserRepository(session).get_by_id(self.user_id)
            return getattr(user, 'context_size', None) or 8192
        context_limit = db.execute_sync(_get_ctx)

        system_messages = [{"role": "system", "content": ""}]
        conversation_messages = system_messages + context_messages

        token_count = self._estimate_tokens(conversation_messages)

        # Signal compacting
        await self.send_event(ContextInfoEvent(
            conversation_id=conversation_id, compacting=True,
        ))

        summary_api_key = gemini_api_key if summary_provider == "gemini" else nvidia_api_key if summary_provider == "nvidia" else None
        await asyncio.to_thread(
            self._compact_context,
            conversation_id, context_limit, conversation_messages,
            summary_model, ollama_url, summary_provider, summary_api_key,
        )

        # Reload to get updated watermark
        compacted_context, compacted_up_to_id, _ = self._load_context_messages(conversation_id)

        # Signal compaction done with updated watermark
        await self.send_event(ContextInfoEvent(
            conversation_id=conversation_id,
            compacted_up_to_id=compacted_up_to_id,
            compacted_context=compacted_context,
        ))

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

    def _handle_client_tools_register(self, event: ClientToolsRegisterEvent, device_name: str = ""):
        """Store tool schemas registered by a specific device and rebuild combined list."""
        self._device_tools[device_name] = event.tools
        self._device_tool_names[device_name] = {
            t.get("function", {}).get("name", "")
            for t in event.tools
            if t.get("function", {}).get("name")
        }
        self._rebuild_client_tools()
        logger.info(
            "Device '%s' registered %d tools for user %d: %s",
            device_name,
            len(event.tools),
            self.user_id,
            ", ".join(sorted(self._device_tool_names.get(device_name, set()))),
        )

    def _rebuild_client_tools(self):
        """Rebuild the combined client tools list from all devices.

        When only one device has tools, no prefix is added.
        When multiple devices have tools, each tool name is prefixed with the device name.
        """
        devices_with_tools = {d: tools for d, tools in self._device_tools.items() if tools}

        self._client_tools = []
        self._client_tool_names = set()
        self._tool_device_map = {}

        if len(devices_with_tools) <= 1:
            # Single device (or none) — no prefix
            for device_name, tools in devices_with_tools.items():
                for tool in tools:
                    original_name = tool.get("function", {}).get("name", "")
                    self._client_tools.append(tool)
                    if original_name:
                        self._client_tool_names.add(original_name)
                        self._tool_device_map[original_name] = (device_name, original_name)
        else:
            # Multiple devices — prefix tool names with device name
            for device_name, tools in devices_with_tools.items():
                prefix = _sanitize_device_prefix(device_name)
                for tool in tools:
                    import copy
                    prefixed_tool = copy.deepcopy(tool)
                    original_name = tool.get("function", {}).get("name", "")
                    if original_name:
                        prefixed_name = f"{prefix}__{original_name}"
                        prefixed_tool["function"]["name"] = prefixed_name
                        if "description" in prefixed_tool.get("function", {}):
                            prefixed_tool["function"]["description"] = (
                                f"[{device_name}] {prefixed_tool['function']['description']}"
                            )
                        self._client_tools.append(prefixed_tool)
                        self._client_tool_names.add(prefixed_name)
                        self._tool_device_map[prefixed_name] = (device_name, original_name)

        logger.debug(
            "Rebuilt client tools for user %d: %d tools from %d device(s)",
            self.user_id, len(self._client_tools), len(devices_with_tools),
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
        """Forward a tool call to the correct device and await the result.

        Uses _tool_device_map to find which device owns the tool and what the
        original (unprefixed) tool name is. Sends ToolCallRequestEvent to that
        device and waits up to 120s for ToolCallResponseEvent.
        """
        import uuid as _uuid

        device_name, original_name = self._tool_device_map.get(tool_name, (self._active_device, tool_name))
        if not device_name or device_name not in self._connections:
            return f"No connected device for tool '{tool_name}'"

        request_id = str(_uuid.uuid4())
        future = asyncio.get_event_loop().create_future()
        self._pending_tool_calls[request_id] = future

        await self._send_to_device(device_name, ToolCallRequestEvent(
            request_id=request_id,
            tool_name=original_name,
            tool_args=tool_args,
        ))

        try:
            result = await asyncio.wait_for(future, timeout=120.0)
            return result
        except asyncio.TimeoutError:
            return f"Client tool '{tool_name}' on device '{device_name}' timed out after 120s"
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
        """Send event to the active device (silently fails if disconnected)."""
        if not self._active_device:
            return
        await self._send_to_device(self._active_device, event)

    async def _send_to_device(self, device_name: str, event: BaseEvent):
        """Send event to a specific device by name."""
        ws = self._connections.get(device_name)
        if not ws:
            return
        event_type = event.type.value if hasattr(event.type, 'value') else event.type
        try:
            async with self._send_lock:
                state = ws.client_state.name
                if state == "CONNECTED":
                    await ws.send_json(event.to_dict())
                else:
                    logger.debug(f"WebSocket not connected (state={state}), dropping {event_type}")
        except Exception:
            logger.debug(f"Failed to send WebSocket event {event_type} (socket closed)")

    async def send_connected_state_to(self, ws: WebSocket, device_name: str = ""):
        """Send a ConnectedEvent with current server-side state snapshot to a specific websocket."""
        from kurisuassistant.media.player import _players

        chat_active = self.current_task is not None and not self.current_task.done()

        # Media state
        media_state = None
        player = _players.get(self.user_id)
        if player:
            media_state = player.get_state()

        event = ConnectedEvent(
            chat_active=chat_active,
            conversation_id=self._task_conversation_id if chat_active or self._task_done else None,
            frame_id=self._task_frame_id if chat_active or self._task_done else None,
            media_state=media_state,
            vision_active=self._vision_processor is not None,
            vision_config=self._vision_config,
            device_name=device_name,
        )
        event_type = event.type.value if hasattr(event.type, 'value') else event.type
        try:
            async with self._send_lock:
                state = ws.client_state.name
                if state == "CONNECTED":
                    await ws.send_json(event.to_dict())
                else:
                    logger.debug(f"WebSocket not connected (state={state}), dropping {event_type}")
        except Exception:
            logger.debug(f"Failed to send WebSocket event {event_type} (socket closed)")

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

    def _load_context_messages(self, conversation_id: int) -> tuple[str, int, list]:
        """Load compacted context and recent messages for a conversation.

        Returns:
            Tuple of (compacted_context, compacted_up_to_id, messages_after_watermark).
            compacted_context is the rolling summary (empty string if none).
            compacted_up_to_id is the message ID watermark.
            messages are all messages with id > compacted_up_to_id.
        """
        db = get_db_service()

        def _query(session):
            conv = session.query(Conversation).filter_by(id=conversation_id).first()
            if not conv:
                return "", 0, []

            compacted_context = conv.compacted_context or ""
            compacted_up_to_id = conv.compacted_up_to_id or 0

            # Load messages after the compaction watermark, across all frames
            messages = (
                session.query(Message)
                .join(Frame, Message.frame_id == Frame.id)
                .filter(Frame.conversation_id == conversation_id)
                .filter(Message.id > compacted_up_to_id)
                .order_by(Message.created_at)
                .all()
            )

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
                if msg.thinking:
                    entry["thinking"] = msg.thinking
                result.append(entry)
            return compacted_context, compacted_up_to_id, result

        return db.execute_sync(_query)

    @staticmethod
    def _estimate_tokens(messages: list) -> int:
        """Estimate token count from messages using word_count * 1.3."""
        word_count = sum(len(m.get("content", "").split()) for m in messages)
        return int(word_count * 1.3)

    def _compact_context(
        self,
        conversation_id: int,
        context_size: int,
        conversation_messages: list,
        model_name: str,
        api_url: str | None = None,
        provider_type: str = "ollama",
        api_key: str | None = None,
    ) -> str:
        """Compact conversation messages into a short rolling summary.

        Calls the LLM synchronously to summarize the conversation, then stores
        the result on the conversation record.

        Returns:
            The new compacted context string.
        """
        from kurisuassistant.models.llm import create_llm_provider

        target_chars = int(context_size * 0.1 * 4)

        system_prompt = (
            "You are compacting a conversation into a short-term context document.\n"
            "Your output replaces the full message history in the AI's context window.\n\n"
            "This is SHORT-TERM context — the current conversation's state and flow.\n"
            "Do NOT include long-term knowledge (user preferences, personal facts, "
            "learned information about the user) — those are stored separately in the "
            "agent's persistent memory. Focus only on what is needed to continue "
            "THIS conversation coherently.\n\n"
            "STRUCTURE (in this exact order):\n"
            "1. Summary section — third person narrative of older context:\n"
            "   - Current task state, key decisions, tool call outcomes\n"
            "   - Summarize early conversation broadly, keep only what still matters\n"
            "2. Recent messages section — copy the LAST 3-5 exchanges VERBATIM:\n"
            "   - Format: 'User: ...' / 'Assistant: ...' exactly as they appear\n"
            "   - This preserves the conversation's tone, language, and style\n"
            "   - The agent MUST be able to detect what language the user speaks\n"
            "     and match the conversational style from these messages\n\n"
            "RULES:\n"
            "- Summary section: third person narrative (\"The user asked...\", \"It was decided...\")\n"
            "- Recent messages section: exact verbatim copies, do NOT paraphrase\n"
            "- Preserve exact values still relevant: names, numbers, paths, code snippets\n"
            "- Drop from summary: greetings, small talk, repeated explanations, "
            "failed attempts that were superseded\n"
            "- When old and new information conflict, keep only the newer version\n"
            "- Mark any unresolved questions or pending tasks clearly\n"
            f"- Keep under {target_chars} characters\n\n"
            "Output ONLY the compacted context. No preamble, no explanation."
        )

        # Format the conversation as a transcript for the compaction LLM
        transcript_lines = []
        for msg in conversation_messages:
            role = msg.get("role", "user")
            name = msg.get("name", role.capitalize())
            content = msg.get("content", "")
            if content:
                transcript_lines.append(f"{name}: {content}")
        transcript = "\n".join(transcript_lines)

        try:
            llm = create_llm_provider(provider_type, api_url=api_url, api_key=api_key)
            response = llm.chat(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": transcript},
                ],
                stream=False,
            )
            new_context = response.message.content.strip()
            if len(new_context) > target_chars:
                new_context = new_context[:target_chars]
        except Exception as e:
            logger.error("Context compaction failed: %s", e, exc_info=True)
            return ""

        # Find the last message ID in the conversation for the watermark
        db = get_db_service()

        def _update(session):
            conv = session.query(Conversation).filter_by(id=conversation_id).first()
            if not conv:
                return
            # Get the last message ID across all frames
            last_msg = (
                session.query(Message.id)
                .join(Frame, Message.frame_id == Frame.id)
                .filter(Frame.conversation_id == conversation_id)
                .order_by(desc(Message.id))
                .first()
            )
            compacted_up_to_id = last_msg[0] if last_msg else 0
            ConversationRepository(session).update_compacted_context(
                conv, new_context, compacted_up_to_id
            )

        db.execute_sync(_update)
        logger.info("Compacted context for conversation %d: %d chars", conversation_id, len(new_context))
        return new_context

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
