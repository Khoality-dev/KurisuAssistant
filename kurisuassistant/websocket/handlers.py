"""WebSocket session handler — one conversation, one main agent, optional sub-agent delegation."""

import asyncio
import json
import logging
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import WebSocket

from .events import (
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
    ContextInfoEvent,
    ContextBreakdownEvent,
    CompactContextEvent,
    parse_event,
)
from kurisuassistant.agents import AgentConfig, AgentContext, MainAgent, SubAgent, SubAgentTool
from kurisuassistant.agents.selection import pick_main_agent
from kurisuassistant.tools import tool_registry
from kurisuassistant.vision import VisionProcessor
from sqlalchemy import desc
from kurisuassistant.db.models import Conversation, Message
from kurisuassistant.db.repositories import (
    AgentRepository,
    ConversationRepository,
    MessageRepository,
    UserRepository,
)
from kurisuassistant.db.service import get_db_service
from kurisuassistant.utils.prompts import build_system_messages

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL = 30
HEARTBEAT_TIMEOUT = 10


class ChatSessionHandler:
    """Handles a single WebSocket chat session.

    Flow:
    1. User sends a message
    2. Resolve/create conversation. If ``main_agent_id`` is null, pick one
       (trigger-word scan → random) and persist.
    3. Run MainAgent with SubAgentTool adapters for each enabled SubAgent.
    4. Stream response; save messages with ``conversation_id`` as they complete.
    5. On idle, background worker consolidates agent memory from the conversation.
    """

    def __init__(self, websocket: WebSocket, user_id: int):
        self.websocket = websocket
        self.user_id = user_id
        self.pending_approvals: Dict[str, asyncio.Future] = {}
        self.current_task: Optional[asyncio.Task] = None
        self._send_lock = asyncio.Lock()

        self._task_conversation_id: Optional[int] = None
        self._task_done: bool = False

        self._heartbeat_task: Optional[asyncio.Task] = None
        self._last_pong_time: float = 0

        self._client_tools: List[Dict] = []
        self._client_tool_names: set = set()
        self._pending_tool_calls: Dict[str, asyncio.Future] = {}

        self._message_queue: List[ChatRequestEvent] = []

        self._vision_processor: Optional[VisionProcessor] = None
        self._vision_config: Optional[dict] = None

    async def run(self):
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
                    raise WebSocketDisconnect()
                except Exception as e:
                    logger.error(f"Error handling WebSocket event: {e}", exc_info=True)
                    await self.send_event(ErrorEvent(error=str(e), code="INTERNAL_ERROR"))
        finally:
            my_heartbeat.cancel()
            if self._heartbeat_task is my_heartbeat:
                self._heartbeat_task = None

    async def _heartbeat_loop(self, ws: WebSocket):
        import time
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
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
        elif isinstance(event, CompactContextEvent):
            await self._handle_compact_context(event)

    async def _handle_chat_request(self, event: ChatRequestEvent):
        if self.current_task and not self.current_task.done():
            self._message_queue.append(event)
            logger.debug("Queued message (queue size: %d)", len(self._message_queue))
            return
        self.current_task = asyncio.create_task(self._run_chat(event))

    def _process_queue(self):
        if not self._message_queue:
            return
        queued = list(self._message_queue)
        self._message_queue.clear()
        primary = queued[0]
        extra = queued[1:] if len(queued) > 1 else []
        logger.debug("Processing %d queued messages as single turn", len(queued))
        self.current_task = asyncio.create_task(self._run_chat(primary, extra_messages=extra))

    # ------------------------------------------------------------------
    # Chat orchestration
    # ------------------------------------------------------------------

    async def _run_chat(self, event: ChatRequestEvent, extra_messages: Optional[List] = None):
        """Pick main agent if needed, then run it with sub-agent tools."""
        from fastapi import WebSocketDisconnect
        try:
            setup = await self._setup_conversation(event)
            (conversation_id, system_messages, user_system_prompt, preferred_name,
             ollama_url, gemini_api_key, nvidia_api_key,
             summary_model, summary_provider, context_size,
             existing_main_agent_id) = setup

            self._task_conversation_id = conversation_id
            self._task_done = False

            all_agents = self._load_enabled_agents()
            main_agents = [a for a in all_agents if a.agent_type == 'main']
            sub_agents = [a for a in all_agents if a.agent_type == 'sub']

            if not main_agents:
                await self.send_event(ErrorEvent(
                    error="No main agents available. Please create at least one main agent.",
                    code="NO_MAIN_AGENTS",
                ))
                return

            # Resolve current main agent (persisted on conversation, or pick now).
            current_agent: Optional[AgentConfig] = None
            if existing_main_agent_id is not None:
                current_agent = next(
                    (a for a in main_agents if a.id == existing_main_agent_id),
                    None,
                )
                if current_agent is None:
                    logger.warning(
                        "Conversation %d main_agent_id=%d not in enabled main agents — re-picking",
                        conversation_id, existing_main_agent_id,
                    )
            if current_agent is None:
                current_agent = pick_main_agent(event.text, main_agents)
                self._persist_main_agent(conversation_id, current_agent.id)

            await self.send_event(AgentSwitchEvent(
                from_agent_id=None,
                from_agent_name=None,
                to_agent_id=current_agent.id,
                to_agent_name=current_agent.name,
                reason=f"Selected {current_agent.name}",
            ))

            # Save user's images to disk
            image_uuids: List[str] = []
            if event.images:
                from kurisuassistant.utils.images import save_image_from_base64
                for b64 in event.images:
                    try:
                        image_uuids.append(save_image_from_base64(b64, self.user_id))
                    except Exception as e:
                        logger.warning(f"Failed to save image: {e}")

            compacted_context, compacted_up_to_id, context_messages = self._load_context_messages(conversation_id)

            content = event.text
            if event.context_files:
                refs = " ".join(
                    f"[{cf['path']}:{cf.get('startLine', '')}:{cf.get('startColumn', '')}-{cf.get('endLine', '')}:{cf.get('endColumn', '')}]"
                    if cf.get("startLine") else f"[{cf['path']}]"
                    for cf in event.context_files
                )
                content = refs + "\n" + content

            user_message = {"role": "user", "content": content}
            if image_uuids:
                user_message["images"] = image_uuids
            if event.context_files:
                user_message["context_files"] = event.context_files
            conversation_messages = system_messages + context_messages + [user_message]

            self._save_message(user_message, conversation_id)

            if extra_messages:
                for extra_event in extra_messages:
                    extra_msg = {"role": "user", "content": extra_event.text}
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
                    self._save_message(extra_msg, conversation_id)
                    conversation_messages.append(extra_msg)

            # Context compaction if near context-window limit
            context_limit = context_size or 8192
            token_count = self._estimate_tokens(conversation_messages)

            if token_count > context_limit * 0.9 and summary_model:
                await self.send_event(ContextInfoEvent(
                    conversation_id=conversation_id, compacting=True,
                ))
                summary_api_key = (
                    gemini_api_key if summary_provider == "gemini"
                    else nvidia_api_key if summary_provider == "nvidia"
                    else None
                )
                compacted_context = await asyncio.to_thread(
                    self._compact_context,
                    conversation_id, context_limit, conversation_messages,
                    summary_model, ollama_url, summary_provider, summary_api_key,
                )
                compacted_context, compacted_up_to_id, context_messages = self._load_context_messages(conversation_id)
                conversation_messages = system_messages + context_messages + [user_message]
                token_count = self._estimate_tokens(conversation_messages)
                await self.send_event(ContextInfoEvent(
                    conversation_id=conversation_id,
                    compacted_up_to_id=compacted_up_to_id,
                    compacted_context=compacted_context,
                ))

            self._initial_token_count = token_count
            self._response_word_count = 0

            if image_uuids:
                await self.send_event(StreamChunkEvent(
                    content="", role="user", images=image_uuids,
                    conversation_id=conversation_id,
                ))

            # SubAgent tool adapters injected as extra_tools on the MainAgent
            sub_agent_tools = [SubAgentTool(SubAgent(sa, tool_registry)) for sa in sub_agents]

            agent_context = AgentContext(
                user_id=self.user_id,
                conversation_id=conversation_id,
                model_name=current_agent.model_name or event.model_name,
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

            agent = MainAgent(current_agent, tool_registry)
            agent.extra_tools = sub_agent_tools

            await self._stream_and_save_agent(
                agent=agent,
                agent_config=current_agent,
                messages=conversation_messages,
                context=agent_context,
                conversation_id=conversation_id,
                conversation_messages=conversation_messages,
            )

            self._update_timestamps(conversation_id)
            self._task_done = True
            await self.send_event(DoneEvent(conversation_id=conversation_id))

            self._process_queue()

        except asyncio.CancelledError:
            logger.debug("Chat task cancelled by user")
        except WebSocketDisconnect:
            raise
        except Exception as e:
            logger.error(f"Chat task failed: {e}", exc_info=True)
            await self.send_event(ErrorEvent(error=str(e), code="INTERNAL_ERROR"))
            self._process_queue()

    async def _stream_and_save_agent(
        self,
        agent: MainAgent,
        agent_config: AgentConfig,
        messages: List[Dict],
        context: AgentContext,
        conversation_id: int,
        conversation_messages: List[Dict],
    ) -> str:
        """Stream a MainAgent's response and persist messages as role boundaries cross."""
        current_role = "assistant"
        current_name = agent_config.name
        chunk_content = ""
        chunk_thinking = ""
        current_images: List[str] = []
        current_turn_raw_input: Optional[str] = None
        current_tool_args_json: Optional[str] = None
        current_tool_args: Optional[Dict] = None
        current_tool_status: Optional[str] = None
        final_assistant_content = ""
        last_model_name: Optional[str] = None
        last_provider_type: Optional[str] = None

        async for event in agent.process(messages, context):
            if isinstance(event, ContextBreakdownEvent):
                await self.send_event(event)
                current_turn_raw_input = json.dumps(
                    getattr(agent, 'last_prepared_messages', messages),
                    ensure_ascii=False, default=str,
                )
                continue

            chunk = event

            if chunk.content:
                self._response_word_count += len(chunk.content.split())
            if chunk.thinking:
                self._response_word_count += len(chunk.thinking.split())

            if chunk.model_name:
                last_model_name = chunk.model_name
            if chunk.provider_type:
                last_provider_type = chunk.provider_type

            chunk.voice_reference = agent_config.voice_reference
            chunk.persona_name = agent_config.name
            chunk.token_count = self._initial_token_count + int(self._response_word_count * 1.3)
            await self.send_event(chunk)

            if chunk.images:
                current_images.extend(chunk.images)

            if chunk.role != current_role:
                if chunk_content or chunk_thinking:
                    raw_in = current_turn_raw_input if current_role == "assistant" else current_tool_args_json
                    completed_msg = {
                        "role": current_role,
                        "content": chunk_content,
                        "thinking": chunk_thinking if chunk_thinking else None,
                        "agent_id": agent_config.id if current_role == "assistant" else None,
                        "name": current_name,
                        "raw_input": raw_in,
                        "raw_output": chunk_content if current_role == "assistant" else None,
                        "images": current_images if current_images else None,
                        "model_name": last_model_name if current_role == "assistant" else None,
                        "provider_type": last_provider_type if current_role == "assistant" else None,
                        "tool_args": current_tool_args if current_role == "tool" else None,
                        "tool_status": current_tool_status if current_role == "tool" else None,
                    }
                    self._save_message(completed_msg, conversation_id)
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
                current_tool_status = chunk.tool_status if chunk.tool_status else None
            else:
                chunk_content += chunk.content
                if chunk.thinking:
                    chunk_thinking += chunk.thinking

        if chunk_content or chunk_thinking:
            raw_in = current_turn_raw_input if current_role == "assistant" else current_tool_args_json
            completed_msg = {
                "role": current_role,
                "content": chunk_content,
                "thinking": chunk_thinking if chunk_thinking else None,
                "agent_id": agent_config.id if current_role == "assistant" else None,
                "name": current_name,
                "raw_input": raw_in,
                "raw_output": chunk_content if current_role == "assistant" else None,
                "images": current_images if current_images else None,
                "model_name": last_model_name if current_role == "assistant" else None,
                "provider_type": last_provider_type if current_role == "assistant" else None,
                "tool_args": current_tool_args if current_role == "tool" else None,
                "tool_status": current_tool_status if current_role == "tool" else None,
            }
            self._save_message(completed_msg, conversation_id)
            conversation_messages.append({
                "role": current_role,
                "content": chunk_content,
                "agent_id": agent_config.id if current_role == "assistant" else None,
                "name": current_name,
            })
            if current_role == "assistant":
                final_assistant_content += chunk_content

        return final_assistant_content

    # ------------------------------------------------------------------
    # Setup helpers
    # ------------------------------------------------------------------

    async def _setup_conversation(self, event: ChatRequestEvent):
        """Return (conversation_id, system_messages, user_sys_prompt, preferred_name,
        ollama_url, gemini_api_key, nvidia_api_key, summary_model, summary_provider,
        context_size, main_agent_id).
        """
        db = get_db_service()

        def _do_setup(session):
            conv_repo = ConversationRepository(session)
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
                main_agent_id = None
            else:
                conversation_id = event.conversation_id
                conv = conv_repo.get_by_user_and_id(self.user_id, conversation_id)
                main_agent_id = conv.main_agent_id if conv else None

            system_prompt, preferred_name = user_repo.get_preferences(user)

            return (conversation_id, system_prompt, preferred_name,
                    ollama_url, gemini_api_key, nvidia_api_key,
                    summary_model, summary_provider, context_size,
                    main_agent_id)

        (conversation_id, system_prompt, preferred_name,
         ollama_url, gemini_api_key, nvidia_api_key,
         summary_model, summary_provider, context_size,
         main_agent_id) = await db.execute(_do_setup)

        system_messages = build_system_messages(system_prompt, preferred_name)

        return (conversation_id, system_messages, system_prompt, preferred_name or "",
                ollama_url, gemini_api_key, nvidia_api_key,
                summary_model, summary_provider, context_size,
                main_agent_id)

    def _persist_main_agent(self, conversation_id: int, agent_id: int) -> None:
        """Save the picked main agent on the conversation (one-time at first message)."""
        db = get_db_service()

        def _update(session):
            conv_repo = ConversationRepository(session)
            conv = conv_repo.get_by_id(conversation_id)
            if conv:
                conv_repo.update_main_agent(conv, agent_id)

        db.execute_sync(_update)

    def _load_enabled_agents(self) -> List[AgentConfig]:
        db = get_db_service()

        def _query(session):
            agents = AgentRepository(session).list_enabled_for_user(self.user_id)
            return [self._agent_to_config(agent) for agent in agents]

        return db.execute_sync(_query)

    @staticmethod
    def _agent_to_config(agent) -> AgentConfig:
        return AgentConfig(
            id=agent.id,
            name=agent.name,
            description=agent.description or "",
            system_prompt=agent.system_prompt or "",
            model_name=agent.model_name,
            provider_type=getattr(agent, 'provider_type', 'ollama') or 'ollama',
            available_tools=agent.available_tools,
            think=agent.think,
            memory=agent.memory,
            memory_enabled=agent.memory_enabled,
            enabled=agent.enabled,
            is_system=agent.is_system,
            use_deferred_tools=getattr(agent, 'use_deferred_tools', False),
            voice_reference=getattr(agent, 'voice_reference', None),
            avatar_uuid=getattr(agent, 'avatar_uuid', None),
            character_config=getattr(agent, 'character_config', None),
            preferred_name=getattr(agent, 'preferred_name', None),
            trigger_word=getattr(agent, 'trigger_word', None),
            agent_type=getattr(agent, 'agent_type', 'main'),
        )

    def _update_timestamps(self, conversation_id: int):
        db = get_db_service()

        def _update(session):
            conv_repo = ConversationRepository(session)
            conversation = conv_repo.get_by_id(conversation_id)
            if conversation:
                conv_repo.update_timestamp(conversation)

        db.execute_sync(_update)

    # ------------------------------------------------------------------
    # Tool approval / cancel / vision / client-tools — unchanged plumbing
    # ------------------------------------------------------------------

    async def _handle_approval_response(self, event: ToolApprovalResponseEvent):
        if event.approval_id in self.pending_approvals:
            future = self.pending_approvals[event.approval_id]
            if not future.done():
                future.set_result(event)

    async def _handle_cancel(self):
        self._message_queue.clear()
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()

    async def _handle_compact_context(self, event: CompactContextEvent):
        conversation_id = event.conversation_id
        if not conversation_id:
            return

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

        compacted_context, compacted_up_to_id, context_messages = self._load_context_messages(conversation_id)
        if not context_messages:
            return

        def _get_ctx(session):
            user = UserRepository(session).get_by_id(self.user_id)
            return getattr(user, 'context_size', None) or 8192

        context_limit = db.execute_sync(_get_ctx)

        system_messages = [{"role": "system", "content": ""}]
        conversation_messages = system_messages + context_messages

        await self.send_event(ContextInfoEvent(conversation_id=conversation_id, compacting=True))

        summary_api_key = (
            gemini_api_key if summary_provider == "gemini"
            else nvidia_api_key if summary_provider == "nvidia"
            else None
        )
        await asyncio.to_thread(
            self._compact_context,
            conversation_id, context_limit, conversation_messages,
            summary_model, ollama_url, summary_provider, summary_api_key,
        )

        compacted_context, compacted_up_to_id, _ = self._load_context_messages(conversation_id)

        await self.send_event(ContextInfoEvent(
            conversation_id=conversation_id,
            compacted_up_to_id=compacted_up_to_id,
            compacted_context=compacted_context,
        ))

    async def _handle_vision_start(self, event: VisionStartEvent):
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
        if not self._vision_processor:
            return
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, self._vision_processor.process_frame, event.frame)
        if result:
            await self.send_event(VisionResultEvent(
                faces=result.get("faces", []),
                gestures=result.get("gestures", []),
            ))

    async def _handle_vision_stop(self):
        self._vision_processor = None
        self._vision_config = None
        logger.debug("Vision processing stopped for user %d", self.user_id)

    def _handle_client_tools_register(self, event: ClientToolsRegisterEvent):
        self._client_tools = event.tools
        self._client_tool_names = {
            t.get("function", {}).get("name", "")
            for t in event.tools
            if t.get("function", {}).get("name")
        }
        logger.info(
            "Client registered %d tools for user %d: %s",
            len(self._client_tools), self.user_id,
            ", ".join(sorted(self._client_tool_names)),
        )

    def _handle_tool_call_response(self, event: ToolCallResponseEvent):
        future = self._pending_tool_calls.pop(event.request_id, None)
        if future and not future.done():
            if event.is_error:
                future.set_result(f"Client tool error: {event.content}")
            else:
                future.set_result(event.content)
        else:
            logger.warning("Received tool_call_response for unknown request_id=%s", event.request_id)

    async def _execute_client_tool(self, tool_name: str, tool_args: Dict) -> str:
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

    # ------------------------------------------------------------------
    # Send / state / reconnect
    # ------------------------------------------------------------------

    async def send_event(self, event: BaseEvent):
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
        chat_active = self.current_task is not None and not self.current_task.done()
        await self.send_event(ConnectedEvent(
            chat_active=chat_active,
            conversation_id=self._task_conversation_id if chat_active or self._task_done else None,
            vision_active=self._vision_processor is not None,
            vision_config=self._vision_config,
        ))

    async def replace_websocket(self, websocket: WebSocket):
        self.websocket = websocket
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None

    async def request_tool_approval(
        self,
        request: ToolApprovalRequestEvent,
    ) -> ToolApprovalResponseEvent:
        future = asyncio.get_event_loop().create_future()
        self.pending_approvals[request.approval_id] = future
        await self.send_event(request)

        try:
            response = await asyncio.wait_for(future, timeout=300.0)
            return response
        except asyncio.TimeoutError:
            return ToolApprovalResponseEvent(
                approval_id=request.approval_id,
                approved=False,
            )
        finally:
            if request.approval_id in self.pending_approvals:
                del self.pending_approvals[request.approval_id]

    # ------------------------------------------------------------------
    # Context loading + compaction
    # ------------------------------------------------------------------

    def _load_context_messages(self, conversation_id: int) -> tuple[str, int, list]:
        """Load (compacted_context, compacted_up_to_id, messages_after_watermark)."""
        db = get_db_service()

        def _query(session):
            conv = session.query(Conversation).filter_by(id=conversation_id).first()
            if not conv:
                return "", 0, []

            compacted_context = conv.compacted_context or ""
            compacted_up_to_id = conv.compacted_up_to_id or 0

            messages = (
                session.query(Message)
                .filter(Message.conversation_id == conversation_id)
                .filter(Message.id > compacted_up_to_id)
                .order_by(Message.created_at)
                .all()
            )

            result = []
            for msg in messages:
                entry = {"role": msg.role, "content": msg.message}
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

        db = get_db_service()

        def _update(session):
            conv = session.query(Conversation).filter_by(id=conversation_id).first()
            if not conv:
                return
            last_msg = (
                session.query(Message.id)
                .filter(Message.conversation_id == conversation_id)
                .order_by(desc(Message.id))
                .first()
            )
            compacted_up_to_id = last_msg[0] if last_msg else 0
            ConversationRepository(session).update_compacted_context(
                conv, new_context, compacted_up_to_id,
            )

        db.execute_sync(_update)
        logger.info("Compacted context for conversation %d: %d chars", conversation_id, len(new_context))
        return new_context

    def _save_message(self, msg: dict, conversation_id: int):
        db = get_db_service()
        db.execute_sync(lambda s: MessageRepository(s).create_message(
            role=msg["role"],
            message=msg["content"],
            conversation_id=conversation_id,
            thinking=msg.get("thinking"),
            agent_id=msg.get("agent_id"),
            name=msg.get("name"),
            raw_input=msg.get("raw_input"),
            raw_output=msg.get("raw_output"),
            images=msg.get("images"),
            model_name=msg.get("model_name"),
            provider_type=msg.get("provider_type"),
            tool_args=msg.get("tool_args"),
            tool_status=msg.get("tool_status"),
            context_files=msg.get("context_files"),
        ))
