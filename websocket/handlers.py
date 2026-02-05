"""WebSocket session handlers."""

import asyncio
import logging
from typing import Dict, Optional

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
    parse_event,
)
from agents.base import AgentConfig, AgentContext, BaseAgent
from agents.router import RouterAgent
from tools import tool_registry
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


class ChatSessionHandler:
    """Handles a single WebSocket chat session."""

    def __init__(self, websocket: WebSocket, user_id: int):
        self.websocket = websocket
        self.user_id = user_id
        self.pending_approvals: Dict[str, asyncio.Future] = {}
        self.current_task: Optional[asyncio.Task] = None

    async def run(self):
        """Main handler loop - receives and processes events."""
        while True:
            try:
                data = await self.websocket.receive_json()
                event = parse_event(data)
                await self._handle_event(event)
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

    async def _handle_chat_request(self, event: ChatRequestEvent):
        """Handle incoming chat request."""
        # Cancel any existing task
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                pass

        # Start new chat task
        self.current_task = asyncio.create_task(
            self._process_chat(event)
        )

    async def _process_chat(self, event: ChatRequestEvent):
        """Process chat request with agent."""
        try:
            # Setup conversation/frame
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
                    conversation = conv_repo.create_conversation(self.user_id)
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

            # Load context messages
            context_messages = self._load_context_messages(conversation_id, frame_id)

            # Build system messages
            system_messages = build_system_messages(system_prompt, preferred_name)

            # Create user message
            user_message = {
                "role": "user",
                "content": event.text,
            }

            # Full message list
            messages = system_messages + context_messages + [user_message]

            # Create agent context
            agent_context = AgentContext(
                user_id=self.user_id,
                conversation_id=conversation_id,
                frame_id=frame_id,
                model_name=event.model_name,
                handler=self,
            )

            # Get or create agent
            if event.agent_id:
                agent = self._load_agent(event.agent_id)
            else:
                # Use router agent
                router_config = AgentConfig(name="router")
                agent = RouterAgent(router_config, tool_registry)

            # Collect messages for DB persistence
            messages_to_save = [user_message]
            current_content = ""
            current_thinking = ""
            current_role = "assistant"

            # Stream response
            async for chunk in agent.process(messages, agent_context):
                # Send to client
                await self.send_event(chunk)

                # Accumulate for DB
                if chunk.role != current_role:
                    # Save previous message
                    if current_content or current_thinking:
                        messages_to_save.append({
                            "role": current_role,
                            "content": current_content,
                            "thinking": current_thinking if current_thinking else None,
                        })
                    current_role = chunk.role
                    current_content = chunk.content
                    current_thinking = chunk.thinking or ""
                else:
                    current_content += chunk.content
                    if chunk.thinking:
                        current_thinking += chunk.thinking

            # Save final message
            if current_content or current_thinking:
                messages_to_save.append({
                    "role": current_role,
                    "content": current_content,
                    "thinking": current_thinking if current_thinking else None,
                })

            # Persist to DB
            await self._save_messages(messages_to_save, frame_id)

            # Update timestamps
            with get_session() as session:
                frame_repo = FrameRepository(session)
                conv_repo = ConversationRepository(session)

                frame = frame_repo.get_by_id(frame_id)
                if frame:
                    frame_repo.update_timestamp(frame)

                conversation = conv_repo.get_by_id(conversation_id)
                if conversation:
                    conv_repo.update_timestamp(conversation)

            # Send done event
            await self.send_event(DoneEvent(
                conversation_id=conversation_id,
                frame_id=frame_id,
            ))

        except asyncio.CancelledError:
            await self.send_event(ErrorEvent(
                error="Request cancelled",
                code="CANCELLED",
            ))
        except Exception as e:
            logger.error(f"Chat processing failed: {e}", exc_info=True)
            await self.send_event(ErrorEvent(
                error=str(e),
                code="INTERNAL_ERROR",
            ))

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

    async def send_event(self, event: BaseEvent):
        """Send event to client."""
        try:
            await self.websocket.send_json(event.to_dict())
        except Exception as e:
            logger.error(f"Failed to send WebSocket event: {e}")

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
        """Load context messages from database."""
        with get_session() as session:
            msg_repo = MessageRepository(session)
            messages = msg_repo.get_by_frame(frame_id, limit=1000)

            return [
                {
                    "role": msg.role,
                    "content": msg.message,
                }
                for msg in messages
            ]

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
                )
