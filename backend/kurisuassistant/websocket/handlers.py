"""WebSocket session handler — one conversation, one persona, optional sub-agent delegation."""

import asyncio
import json
import logging
from dataclasses import dataclass, field
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
    VisionStartEvent,
    VisionFrameEvent,
    VisionStopEvent,
    VisionResultEvent,
    ClientToolsRegisterEvent,
    ToolCallResponseEvent,
    ContextInfoEvent,
    ConversationSwitchedEvent,
    CompactContextEvent,
    parse_event,
)
from kurisuassistant.agents import (
    AgentContext,
    AssistantConfig,
    MainAgent,
    PersonaConfig,
    SubAgent,
    SubAgentConfig,
    SubAgentTool,
)
from kurisuassistant.agents.selection import pick_persona
from kurisuassistant.tools import tool_registry
from kurisuassistant.vision import VisionProcessor
from sqlalchemy import desc
from kurisuassistant.db.models import Conversation, Message
from kurisuassistant.db.repositories import (
    AssistantRepository,
    ConversationRepository,
    MessageRepository,
    PersonaRepository,
    SubAgentRepository,
    UserRepository,
)
from kurisuassistant.core.errors import GENERIC_MESSAGE, log_internal_error
from kurisuassistant.db.service import get_db_service
from kurisuassistant.utils.prompts import build_system_messages

logger = logging.getLogger(__name__)

# A turn can take minutes, and a client is free to keep typing while it runs.
# The queue is merged into one follow-up turn, so it needs a ceiling.
MAX_QUEUED_MESSAGES = 20


@dataclass
class _TurnSetup:
    """Everything a turn needs from the database, read in one round trip.

    The assistant row is read here rather than alongside the personas: it is a
    single row keyed by user, so folding it into the setup query costs nothing
    and saves a second trip to the DB thread.
    """
    conversation_id: int
    # The conversation's current persona binding — None until the first message
    # binds it.
    persona_id: Optional[int]
    assistant: AssistantConfig
    default_persona_id: Optional[int]
    system_messages: List[Dict] = field(default_factory=list)
    user_system_prompt: str = ""
    preferred_name: str = ""
    ollama_url: Optional[str] = None
    gemini_api_key: Optional[str] = None
    nvidia_api_key: Optional[str] = None
    summary_model: Optional[str] = None
    summary_provider: str = "ollama"
    context_size: Optional[int] = None
    tool_policies: Dict[str, str] = field(default_factory=dict)


class ChatSessionHandler:
    """Handles a single WebSocket chat session.

    Flow:
    1. User sends a message
    2. Resolve/create conversation. If ``persona_id`` is null, bind it —
       explicit override → the assistant's default persona — and persist.
    3. Run MainAgent (the user's single assistant, speaking as that persona)
       with SubAgentTool adapters for each enabled SubAgent.
    4. Stream response; save messages with ``conversation_id`` as they complete.
    5. On idle, background worker consolidates assistant memory from the conversation.
    """

    def __init__(self, websocket: WebSocket, user_id: int):
        self.websocket = websocket
        self.user_id = user_id
        self.pending_approvals: Dict[str, asyncio.Future] = {}
        self.current_task: Optional[asyncio.Task] = None
        self._send_lock = asyncio.Lock()

        self._task_conversation_id: Optional[int] = None
        self._task_persona_id: Optional[int] = None
        self._task_done: bool = False

        self._client_tools: List[Dict] = []
        self._client_tool_names: set = set()
        self._pending_tool_calls: Dict[str, asyncio.Future] = {}

        self._message_queue: List[ChatRequestEvent] = []

        self._vision_processor: Optional[VisionProcessor] = None
        self._vision_config: Optional[dict] = None

    async def run(self):
        from fastapi import WebSocketDisconnect

        ws = self.websocket
        while True:
            try:
                data = await ws.receive_json()
                if data.get("type") == "pong":
                    # Clients still answer the old application-level ping. The
                    # server no longer sends one, so this just ignores stragglers.
                    continue
                event = parse_event(data)
                await self._handle_event(event)
            except WebSocketDisconnect:
                raise
            except RuntimeError:
                raise WebSocketDisconnect()
            except Exception as e:
                reference = log_internal_error(e, "handling a WebSocket event")
                await self.send_event(ErrorEvent(
                    error=f"{GENERIC_MESSAGE} (reference: {reference})",
                    code="INTERNAL_ERROR",
                ))

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
            if len(self._message_queue) >= MAX_QUEUED_MESSAGES:
                logger.warning(
                    "Dropping a message for user %d: %d already queued",
                    self.user_id, len(self._message_queue),
                )
                await self.send_event(ErrorEvent(
                    error=(
                        "Too many messages queued while the assistant is replying. "
                        "Wait for the current reply to finish."
                    ),
                    code="QUEUE_FULL",
                ))
                return
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
        """Bind the conversation to a persona if needed, then run the assistant."""
        from fastapi import WebSocketDisconnect
        try:
            setup = await self._setup_conversation(event)
            conversation_id = setup.conversation_id
            assistant = setup.assistant

            self._task_conversation_id = conversation_id
            self._task_done = False

            personas, sub_agents = await self._load_agents()

            if not personas:
                await self.send_event(ErrorEvent(
                    error="No personas available. Please create at least one persona.",
                    code="NO_PERSONAS",
                ))
                return

            # Binding precedence: an explicit choice for this turn (``persona_id``
            # on this chat_request, or a PATCH that already wrote
            # ``conversations.persona_id``) → the conversation's existing
            # binding → the assistant's default persona. A new conversation
            # adopts the default silently; nothing scans for a trigger word and
            # nothing is picked at random.
            override_id = (
                event.persona_id if event.persona_id is not None else setup.persona_id
            )
            persona = pick_persona(
                personas,
                override_id=override_id,
                default_persona_id=setup.default_persona_id,
            )
            self._task_persona_id = persona.id
            if persona.id != setup.persona_id:
                # Runs on a rebind too, not only on the first bind: an override
                # that is not written back is forgotten by the next message.
                await self._persist_persona(conversation_id, persona.id)

            # Save user's images to disk
            image_uuids: List[str] = []
            if event.images:
                from kurisuassistant.utils.images import save_image_from_base64
                for b64 in event.images:
                    try:
                        image_uuids.append(save_image_from_base64(b64, self.user_id))
                    except Exception as e:
                        logger.warning(f"Failed to save image: {e}")

            compacted_context, compacted_up_to_id, context_messages = await self._load_context_messages(conversation_id)

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

            extra_msgs_prepared = []
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
                    extra_msgs_prepared.append(extra_msg)

            # Context compaction if near context-window limit. The pending user
            # message + extras are NOT included in the summary — they land as
            # the first messages of the new conversation that gets created.
            context_limit = setup.context_size or 8192
            pre_check_messages = (
                setup.system_messages + context_messages + [user_message] + extra_msgs_prepared
            )
            token_count = self._estimate_tokens(pre_check_messages)

            if token_count > context_limit * 0.9 and setup.summary_model:
                await self.send_event(ContextInfoEvent(
                    conversation_id=conversation_id, compacting=True,
                ))
                summary_api_key = (
                    setup.gemini_api_key if setup.summary_provider == "gemini"
                    else setup.nvidia_api_key if setup.summary_provider == "nvidia"
                    else None
                )
                summary_input = setup.system_messages + context_messages
                summary = await asyncio.to_thread(
                    self._generate_summary,
                    context_limit, summary_input,
                    setup.summary_model, setup.ollama_url, setup.summary_provider,
                    summary_api_key,
                )
                if summary:
                    # The new conversation carries the persona binding — without
                    # it a compacted conversation comes back with no voice.
                    new_conversation_id = await asyncio.to_thread(
                        self._create_summary_conversation,
                        persona.id, summary,
                    )
                    old_conversation_id = conversation_id
                    conversation_id = new_conversation_id
                    self._task_conversation_id = new_conversation_id
                    compacted_context = summary
                    compacted_up_to_id = 0
                    context_messages = []
                    await self.send_event(ConversationSwitchedEvent(
                        old_conversation_id=old_conversation_id,
                        new_conversation_id=new_conversation_id,
                        compacted_context=summary,
                        persona_id=persona.id or 0,
                    ))

            # Save the pending user message + extras to the (possibly new) conversation
            await self._save_message(user_message, conversation_id)
            for extra_msg in extra_msgs_prepared:
                await self._save_message(extra_msg, conversation_id)
            conversation_messages = (
                setup.system_messages + context_messages + [user_message] + extra_msgs_prepared
            )
            token_count = self._estimate_tokens(conversation_messages)

            self._initial_token_count = token_count
            self._response_word_count = 0

            if image_uuids:
                await self.send_event(StreamChunkEvent(
                    content="", role="user", images=image_uuids,
                    conversation_id=conversation_id,
                ))

            # SubAgent tool adapters injected as extra_tools on the MainAgent
            taken_tool_names: set = set()
            sub_agent_tools = [
                SubAgentTool(SubAgent(sa, tool_registry), taken_tool_names)
                for sa in sub_agents
            ]

            agent_context = AgentContext(
                user_id=self.user_id,
                conversation_id=conversation_id,
                # The fallback model for anything that has none of its own. It
                # now comes from the ASSISTANT rather than from the selected
                # main agent: a sub-agent with a null ``model_name`` inherits
                # the assistant's model, not the persona's (a persona has none).
                model_name=assistant.model_name or event.model_name,
                handler=self,
                user_system_prompt=setup.user_system_prompt,
                preferred_name=setup.preferred_name,
                api_url=setup.ollama_url,
                gemini_api_key=setup.gemini_api_key,
                nvidia_api_key=setup.nvidia_api_key,
                client_tools=self._client_tools,
                client_tool_callback=self._execute_client_tool,
                images=event.images if event.images else None,
                context_size=setup.context_size,
                compacted_context=compacted_context,
                tool_policies=setup.tool_policies,
            )

            agent = MainAgent(assistant, tool_registry, identity=persona)
            agent.extra_tools = sub_agent_tools

            await self._stream_and_save_agent(
                agent=agent,
                persona=persona,
                messages=conversation_messages,
                context=agent_context,
                conversation_id=conversation_id,
                conversation_messages=conversation_messages,
            )

            await self._update_timestamps(conversation_id)
            self._task_done = True
            await self.send_event(DoneEvent(conversation_id=conversation_id))

            self._process_queue()

        except asyncio.CancelledError:
            logger.debug("Chat task cancelled by user")
        except WebSocketDisconnect:
            raise
        except Exception as e:
            reference = log_internal_error(e, "running a chat turn")
            await self.send_event(ErrorEvent(
                error=f"{GENERIC_MESSAGE} (reference: {reference})",
                code="INTERNAL_ERROR",
            ))
            self._process_queue()

    async def _stream_and_save_agent(
        self,
        agent: MainAgent,
        persona: PersonaConfig,
        messages: List[Dict],
        context: AgentContext,
        conversation_id: int,
        conversation_messages: List[Dict],
    ) -> str:
        """Stream a MainAgent's response and persist messages as role boundaries cross."""
        current_role = "assistant"
        current_name = persona.name
        chunk_content = ""
        chunk_thinking = ""
        current_images: List[str] = []
        current_tool_args_json: Optional[str] = None
        current_tool_args: Optional[Dict] = None
        current_tool_status: Optional[str] = None
        current_tool_calls: Optional[List[Dict]] = None
        current_tool_call_id: Optional[str] = None
        final_assistant_content = ""
        last_model_name: Optional[str] = None
        last_provider_type: Optional[str] = None

        async for event in agent.process(messages, context):
            chunk = event

            if chunk.content:
                self._response_word_count += len(chunk.content.split())
            if chunk.thinking:
                self._response_word_count += len(chunk.thinking.split())

            if chunk.model_name:
                last_model_name = chunk.model_name
            if chunk.provider_type:
                last_provider_type = chunk.provider_type

            # The voice belongs to the persona, and only an assistant chunk is
            # the persona speaking; a tool chunk keeps its own ``name`` and no
            # persona attribution.
            if chunk.role == "assistant":
                chunk.voice_reference = persona.voice_reference
                chunk.persona_id = persona.id
                chunk.persona_name = persona.name
            chunk.token_count = self._initial_token_count + int(self._response_word_count * 1.3)
            await self.send_event(chunk)

            if chunk.images:
                current_images.extend(chunk.images)
            if chunk.tool_calls:
                current_tool_calls = chunk.tool_calls
            if chunk.tool_call_id and chunk.role == current_role:
                current_tool_call_id = chunk.tool_call_id

            if chunk.role != current_role:
                if chunk_content or chunk_thinking:
                    raw_in = (
                        json.dumps(
                            getattr(agent, 'last_prepared_messages', messages),
                            ensure_ascii=False, default=str,
                        )
                        if current_role == "assistant"
                        else current_tool_args_json
                    )
                    completed_msg = {
                        "role": current_role,
                        "content": chunk_content,
                        "thinking": chunk_thinking if chunk_thinking else None,
                        "persona_id": persona.id if current_role == "assistant" else None,
                        "name": current_name,
                        "raw_input": raw_in,
                        "raw_output": chunk_content if current_role == "assistant" else None,
                        "images": current_images if current_images else None,
                        "model_name": last_model_name if current_role == "assistant" else None,
                        "provider_type": last_provider_type if current_role == "assistant" else None,
                        "tool_args": current_tool_args if current_role == "tool" else None,
                        "tool_status": current_tool_status if current_role == "tool" else None,
                        "tool_calls": current_tool_calls if current_role == "assistant" else None,
                        "tool_call_id": current_tool_call_id if current_role == "tool" else None,
                    }
                    await self._save_message(completed_msg, conversation_id)
                    conversation_messages.append({
                        "role": current_role,
                        "content": chunk_content,
                        "persona_id": persona.id if current_role == "assistant" else None,
                        "name": current_name,
                    })
                    if current_role == "assistant":
                        final_assistant_content += chunk_content
                current_role = chunk.role
                current_name = chunk.name or persona.name
                chunk_content = chunk.content
                chunk_thinking = chunk.thinking or ""
                current_images = []
                current_tool_args_json = json.dumps(chunk.tool_args, ensure_ascii=False) if chunk.tool_args else None
                current_tool_args = chunk.tool_args if chunk.tool_args else None
                current_tool_status = chunk.tool_status if chunk.tool_status else None
                current_tool_calls = chunk.tool_calls
                current_tool_call_id = chunk.tool_call_id
            else:
                chunk_content += chunk.content
                if chunk.thinking:
                    chunk_thinking += chunk.thinking

        if chunk_content or chunk_thinking:
            raw_in = (
                json.dumps(
                    getattr(agent, 'last_prepared_messages', messages),
                    ensure_ascii=False, default=str,
                )
                if current_role == "assistant"
                else current_tool_args_json
            )
            completed_msg = {
                "role": current_role,
                "content": chunk_content,
                "thinking": chunk_thinking if chunk_thinking else None,
                "persona_id": persona.id if current_role == "assistant" else None,
                "name": current_name,
                "raw_input": raw_in,
                "raw_output": chunk_content if current_role == "assistant" else None,
                "images": current_images if current_images else None,
                "model_name": last_model_name if current_role == "assistant" else None,
                "provider_type": last_provider_type if current_role == "assistant" else None,
                "tool_args": current_tool_args if current_role == "tool" else None,
                "tool_status": current_tool_status if current_role == "tool" else None,
            }
            await self._save_message(completed_msg, conversation_id)
            conversation_messages.append({
                "role": current_role,
                "content": chunk_content,
                "persona_id": persona.id if current_role == "assistant" else None,
                "name": current_name,
            })
            if current_role == "assistant":
                final_assistant_content += chunk_content

        return final_assistant_content

    # ------------------------------------------------------------------
    # Setup helpers
    # ------------------------------------------------------------------

    async def _setup_conversation(self, event: ChatRequestEvent) -> "_TurnSetup":
        """Read everything this turn needs from the DB in one round trip.

        The user's assistant row is read (and created on first use) here rather
        than with the personas: it is one row keyed by user, so it costs nothing
        to fold in and saves a second hop to the DB thread.
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
            # Read once per turn; the agent consults this before every tool call
            # so a policy decision never needs a DB round trip mid-stream.
            tool_policies = dict((user.tool_policies or {}).get("tools", {}))

            # Exactly one assistant per user. Created on demand so a user who
            # predates the split, or was made without one, can still chat.
            assistant_row = AssistantRepository(session).get_or_create_for_user(self.user_id)
            assistant = self._to_assistant_config(assistant_row)
            default_persona_id = assistant_row.default_persona_id

            if event.conversation_id is None:
                title = (event.text[:80] + "...") if len(event.text) > 80 else event.text
                conversation = conv_repo.create_conversation(self.user_id, title=title)
                conversation_id = conversation.id
                persona_id = None
            else:
                conversation_id = event.conversation_id
                conv = conv_repo.get_by_user_and_id(self.user_id, conversation_id)
                persona_id = conv.persona_id if conv else None

            system_prompt, preferred_name = user_repo.get_preferences(user)

            return _TurnSetup(
                conversation_id=conversation_id,
                persona_id=persona_id,
                assistant=assistant,
                default_persona_id=default_persona_id,
                system_messages=build_system_messages(system_prompt, preferred_name),
                user_system_prompt=system_prompt,
                preferred_name=preferred_name or "",
                ollama_url=ollama_url,
                gemini_api_key=gemini_api_key,
                nvidia_api_key=nvidia_api_key,
                summary_model=summary_model,
                summary_provider=summary_provider,
                context_size=context_size,
                tool_policies=tool_policies,
            )

        return await db.execute(_do_setup)

    async def _persist_persona(self, conversation_id: int, persona_id: int) -> None:
        """Write the conversation's persona binding.

        Runs on the first bind and on every later override, so a rebind
        survives to the next message.
        """
        db = get_db_service()

        def _update(session):
            conv_repo = ConversationRepository(session)
            conv = conv_repo.get_by_id(conversation_id)
            if conv:
                conv_repo.update_persona(conv, persona_id)

        await db.execute(_update)

    async def _load_agents(self) -> tuple[List[PersonaConfig], List[SubAgentConfig]]:
        """Load the user's enabled personas and sub-agents in one round trip."""
        db = get_db_service()

        def _query(session):
            personas = [
                self._to_persona_config(p)
                for p in PersonaRepository(session).list_enabled_by_user(self.user_id)
            ]
            sub_agents = [
                self._to_sub_agent_config(sa)
                for sa in SubAgentRepository(session).list_enabled_by_user(self.user_id)
            ]
            return personas, sub_agents

        return await db.execute(_query)

    @staticmethod
    def _to_assistant_config(assistant) -> AssistantConfig:
        return AssistantConfig(
            id=assistant.id,
            model_name=assistant.model_name,
            provider_type=assistant.provider_type or 'ollama',
            available_tools=assistant.available_tools,
            think=assistant.think,
            use_deferred_tools=assistant.use_deferred_tools,
            memory=assistant.memory,
            memory_enabled=assistant.memory_enabled,
            trigger_word=assistant.trigger_word,
        )

    @staticmethod
    def _to_persona_config(persona) -> PersonaConfig:
        return PersonaConfig(
            id=persona.id,
            name=persona.name,
            description=persona.description or "",
            system_prompt=persona.system_prompt or "",
            preferred_name=persona.preferred_name,
            voice_reference=persona.voice_reference,
            avatar_uuid=persona.avatar_uuid,
            character_config=persona.character_config,
            enabled=persona.enabled,
        )

    @staticmethod
    def _to_sub_agent_config(sub_agent) -> SubAgentConfig:
        return SubAgentConfig(
            id=sub_agent.id,
            name=sub_agent.name,
            description=sub_agent.description or "",
            system_prompt=sub_agent.system_prompt or "",
            model_name=sub_agent.model_name,
            provider_type=sub_agent.provider_type or 'ollama',
            available_tools=sub_agent.available_tools,
            think=sub_agent.think,
            use_deferred_tools=sub_agent.use_deferred_tools,
        )

    async def _update_timestamps(self, conversation_id: int):
        db = get_db_service()

        def _update(session):
            conv_repo = ConversationRepository(session)
            conversation = conv_repo.get_by_id(conversation_id)
            if conversation:
                conv_repo.update_timestamp(conversation)

        await db.execute(_update)

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
                return None, None, None, None, None, None
            conv = ConversationRepository(session).get_by_user_and_id(self.user_id, conversation_id)
            persona_id = conv.persona_id if conv else None
            return (
                user.summary_model,
                getattr(user, 'summary_provider', 'ollama'),
                user.ollama_url,
                getattr(user, 'gemini_api_key', None),
                getattr(user, 'nvidia_api_key', None),
                persona_id,
            )

        summary_model, summary_provider, ollama_url, gemini_api_key, nvidia_api_key, persona_id = await db.execute(_get_prefs)

        if not summary_model:
            await self.send_event(ErrorEvent(error="No summary model configured.", code="NO_SUMMARY_MODEL"))
            return

        _, _, context_messages = await self._load_context_messages(conversation_id)
        if not context_messages:
            return

        def _get_ctx(session):
            user = UserRepository(session).get_by_id(self.user_id)
            return getattr(user, 'context_size', None) or 8192

        context_limit = await db.execute(_get_ctx)

        await self.send_event(ContextInfoEvent(conversation_id=conversation_id, compacting=True))

        summary_api_key = (
            gemini_api_key if summary_provider == "gemini"
            else nvidia_api_key if summary_provider == "nvidia"
            else None
        )
        summary = await asyncio.to_thread(
            self._generate_summary,
            context_limit, [{"role": "system", "content": ""}] + context_messages,
            summary_model, ollama_url, summary_provider, summary_api_key,
        )

        if not summary:
            await self.send_event(ErrorEvent(error="Compaction produced empty output.", code="COMPACT_EMPTY"))
            return

        # The persona binding follows the conversation across the split.
        new_conversation_id = await asyncio.to_thread(
            self._create_summary_conversation, persona_id, summary,
        )
        self._task_persona_id = persona_id

        await self.send_event(ConversationSwitchedEvent(
            old_conversation_id=conversation_id,
            new_conversation_id=new_conversation_id,
            compacted_context=summary,
            persona_id=persona_id or 0,
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
        show_conversation = chat_active or self._task_done
        await self.send_event(ConnectedEvent(
            chat_active=chat_active,
            conversation_id=self._task_conversation_id if show_conversation else None,
            # Who that conversation is bound to, so a reconnecting client can
            # render the right name and avatar before the first chunk.
            persona_id=self._task_persona_id if show_conversation else None,
            vision_active=self._vision_processor is not None,
            vision_config=self._vision_config,
        ))

    async def replace_websocket(self, websocket: WebSocket):
        """Attach a new socket to this session.

        The tools registered by the previous client are dropped. They belonged to
        that client, and a different one — the phone after the desktop, say —
        cannot run them. Keeping them meant the model was offered desktop-only
        tools whose calls went to a client that ignores them, stalling the turn
        for the full 120-second timeout each time.
        """
        self.websocket = websocket
        if self._client_tools:
            logger.info(
                "Clearing %d client tools registered by the previous session for user %d",
                len(self._client_tools), self.user_id,
            )
        self._client_tools = []
        self._client_tool_names = set()
        for future in self._pending_tool_calls.values():
            if not future.done():
                future.set_result("Client disconnected before the tool call returned")
        self._pending_tool_calls.clear()

    async def shutdown(self) -> None:
        """Release everything this session holds. Called when it is evicted."""
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
        self._message_queue.clear()
        await self._handle_vision_stop()
        for future in list(self._pending_tool_calls.values()) + list(self.pending_approvals.values()):
            if not future.done():
                future.cancel()
        self._pending_tool_calls.clear()
        self.pending_approvals.clear()

        from kurisuassistant.mcp_tools.orchestrator import evict_user_orchestrator
        evict_user_orchestrator(self.user_id)
        logger.info("Session for user %d shut down", self.user_id)

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

    async def _load_context_messages(self, conversation_id: int) -> tuple[str, int, list]:
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
                if msg.persona_id:
                    entry["persona_id"] = msg.persona_id
                if msg.thinking:
                    entry["thinking"] = msg.thinking
                if getattr(msg, "tool_calls", None):
                    entry["tool_calls"] = msg.tool_calls
                if getattr(msg, "tool_call_id", None):
                    entry["tool_call_id"] = msg.tool_call_id
                result.append(entry)
            return compacted_context, compacted_up_to_id, result

        return await db.execute(_query)

    @staticmethod
    def _estimate_tokens(messages: list) -> int:
        word_count = sum(len(m.get("content", "").split()) for m in messages)
        return int(word_count * 1.3)

    def _create_summary_conversation(self, persona_id: Optional[int], summary: str) -> int:
        """Create a new conversation seeded with ``summary`` as compacted_context.

        Used after manual /compact or auto-compaction so the next message
        starts in a fresh conversation with the summary visible at the top.
        The persona binding is carried over — a compacted conversation that
        arrived unbound would silently fall back to the default persona and
        change voice mid-thread.
        """
        db = get_db_service()

        def _create(session):
            conv_repo = ConversationRepository(session)
            conv = conv_repo.create_conversation(
                user_id=self.user_id,
                title="Continued conversation",
                persona_id=persona_id,
            )
            conv_repo.update_compacted_context(conv, summary, 0)
            return conv.id

        return db.execute_sync(_create)

    def _generate_summary(
        self,
        context_size: int,
        conversation_messages: list,
        model_name: str,
        api_url: str | None = None,
        provider_type: str = "ollama",
        api_key: str | None = None,
    ) -> str:
        """LLM-only summary generation. No DB writes."""
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
            return new_context
        except Exception as e:
            logger.error("Context compaction failed: %s", e, exc_info=True)
            return ""

    async def _save_message(self, msg: dict, conversation_id: int):
        db = get_db_service()
        await db.execute(lambda s: MessageRepository(s).create_message(
            role=msg["role"],
            message=msg["content"],
            conversation_id=conversation_id,
            thinking=msg.get("thinking"),
            persona_id=msg.get("persona_id"),
            name=msg.get("name"),
            raw_input=msg.get("raw_input"),
            raw_output=msg.get("raw_output"),
            images=msg.get("images"),
            model_name=msg.get("model_name"),
            provider_type=msg.get("provider_type"),
            tool_args=msg.get("tool_args"),
            tool_status=msg.get("tool_status"),
            tool_calls=msg.get("tool_calls"),
            tool_call_id=msg.get("tool_call_id"),
            context_files=msg.get("context_files"),
        ))
