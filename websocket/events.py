"""WebSocket event types and protocol definitions."""

from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Optional, Dict, Any, List
import uuid


class EventType(str, Enum):
    """Event types for WebSocket protocol."""
    # Client -> Server
    CHAT_REQUEST = "chat_request"
    TOOL_APPROVAL_RESPONSE = "tool_approval_response"
    CANCEL = "cancel"

    # Server -> Client
    STREAM_CHUNK = "stream_chunk"
    TOOL_APPROVAL_REQUEST = "tool_approval_request"
    AGENT_SWITCH = "agent_switch"
    DONE = "done"
    ERROR = "error"


@dataclass
class BaseEvent:
    """Base class for all events."""
    type: EventType
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert event to dictionary for JSON serialization."""
        data = asdict(self)
        data["type"] = self.type.value
        return data


# =============================================================================
# Client -> Server Events
# =============================================================================

@dataclass
class ChatRequestEvent(BaseEvent):
    """Client sends a chat message."""
    type: EventType = field(default=EventType.CHAT_REQUEST)
    text: str = ""
    model_name: str = ""
    conversation_id: Optional[int] = None
    agent_id: Optional[int] = None  # Which agent to use (None = router)
    images: List[str] = field(default_factory=list)  # base64 encoded


@dataclass
class ToolApprovalResponseEvent(BaseEvent):
    """Client responds to tool approval request."""
    type: EventType = field(default=EventType.TOOL_APPROVAL_RESPONSE)
    approval_id: str = ""
    approved: bool = False
    modified_args: Optional[Dict[str, Any]] = None  # User can modify args


@dataclass
class CancelEvent(BaseEvent):
    """Client cancels current request."""
    type: EventType = field(default=EventType.CANCEL)


# =============================================================================
# Server -> Client Events
# =============================================================================

@dataclass
class StreamChunkEvent(BaseEvent):
    """Server streams content chunk."""
    type: EventType = field(default=EventType.STREAM_CHUNK)
    content: str = ""
    thinking: Optional[str] = None
    role: str = "assistant"
    agent_id: Optional[int] = None
    agent_name: Optional[str] = None
    conversation_id: int = 0
    frame_id: int = 0


@dataclass
class ToolApprovalRequestEvent(BaseEvent):
    """Server requests tool approval from client."""
    type: EventType = field(default=EventType.TOOL_APPROVAL_REQUEST)
    approval_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    tool_name: str = ""
    tool_args: Dict[str, Any] = field(default_factory=dict)
    agent_id: Optional[int] = None
    agent_name: Optional[str] = None
    description: str = ""  # Human-readable description
    risk_level: str = "low"  # low, medium, high


@dataclass
class AgentSwitchEvent(BaseEvent):
    """Server notifies client of agent delegation."""
    type: EventType = field(default=EventType.AGENT_SWITCH)
    from_agent_id: Optional[int] = None
    from_agent_name: Optional[str] = None
    to_agent_id: Optional[int] = None
    to_agent_name: Optional[str] = None
    reason: str = ""


@dataclass
class DoneEvent(BaseEvent):
    """Server signals streaming complete."""
    type: EventType = field(default=EventType.DONE)
    conversation_id: int = 0
    frame_id: int = 0


@dataclass
class ErrorEvent(BaseEvent):
    """Server sends error."""
    type: EventType = field(default=EventType.ERROR)
    error: str = ""
    code: str = "INTERNAL_ERROR"  # INTERNAL_ERROR, CANCELLED, TIMEOUT, UNAUTHORIZED


# =============================================================================
# Event Parsing
# =============================================================================

def parse_event(data: Dict[str, Any]) -> BaseEvent:
    """Parse incoming JSON data into appropriate event type."""
    event_type = data.get("type")

    if event_type == EventType.CHAT_REQUEST.value:
        return ChatRequestEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat()),
            text=data.get("text", ""),
            model_name=data.get("model_name", ""),
            conversation_id=data.get("conversation_id"),
            agent_id=data.get("agent_id"),
            images=data.get("images", []),
        )

    elif event_type == EventType.TOOL_APPROVAL_RESPONSE.value:
        return ToolApprovalResponseEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat()),
            approval_id=data.get("approval_id", ""),
            approved=data.get("approved", False),
            modified_args=data.get("modified_args"),
        )

    elif event_type == EventType.CANCEL.value:
        return CancelEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat()),
        )

    else:
        raise ValueError(f"Unknown event type: {event_type}")
