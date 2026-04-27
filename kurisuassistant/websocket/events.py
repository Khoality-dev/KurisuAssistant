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
    VISION_START = "vision_start"
    VISION_FRAME = "vision_frame"
    VISION_STOP = "vision_stop"
    CLIENT_TOOLS_REGISTER = "client_tools_register"
    TOOL_CALL_RESPONSE = "tool_call_response"
    COMPACT_CONTEXT = "compact_context"

    # Server -> Client
    CONNECTED = "connected"
    STREAM_CHUNK = "stream_chunk"
    TOOL_APPROVAL_REQUEST = "tool_approval_request"
    TOOL_CALL_REQUEST = "tool_call_request"
    AGENT_SWITCH = "agent_switch"
    DONE = "done"
    ERROR = "error"
    VISION_RESULT = "vision_result"
    CONTEXT_INFO = "context_info"


@dataclass
class BaseEvent:
    """Base class for all events."""
    type: EventType
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")

    def to_dict(self) -> Dict[str, Any]:
        """Convert event to dictionary for JSON serialization."""
        data = asdict(self)
        data["type"] = self.type.value
        return data


@dataclass
class ConnectedEvent(BaseEvent):
    """Server sends state snapshot on connect/reconnect."""
    type: EventType = field(default=EventType.CONNECTED)
    chat_active: bool = False
    conversation_id: Optional[int] = None
    vision_active: bool = False
    vision_config: Optional[Dict[str, Any]] = None


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
    images: List[str] = field(default_factory=list)  # base64 encoded
    context_files: List[Dict[str, Any]] = field(default_factory=list)  # [{path, fileName, startLine, endLine, ...}]


@dataclass
class ToolApprovalResponseEvent(BaseEvent):
    """Client responds to tool approval request."""
    type: EventType = field(default=EventType.TOOL_APPROVAL_RESPONSE)
    approval_id: str = ""
    approved: bool = False
    modified_args: Optional[Dict[str, Any]] = None  # User can modify args


@dataclass
class CompactContextEvent(BaseEvent):
    """Client requests manual context compaction."""
    type: EventType = field(default=EventType.COMPACT_CONTEXT)
    conversation_id: Optional[int] = None


@dataclass
class CancelEvent(BaseEvent):
    """Client cancels current request."""
    type: EventType = field(default=EventType.CANCEL)


@dataclass
class VisionStartEvent(BaseEvent):
    """Client requests to start vision processing."""
    type: EventType = field(default=EventType.VISION_START)
    enable_face: bool = True
    enable_pose: bool = True
    enable_hands: bool = True


@dataclass
class VisionFrameEvent(BaseEvent):
    """Client sends a webcam frame for inference."""
    type: EventType = field(default=EventType.VISION_FRAME)
    frame: str = ""  # Base64 JPEG


@dataclass
class VisionStopEvent(BaseEvent):
    """Client requests to stop vision processing."""
    type: EventType = field(default=EventType.VISION_STOP)


@dataclass
class ClientToolsRegisterEvent(BaseEvent):
    """Client registers its locally-available tools."""
    type: EventType = field(default=EventType.CLIENT_TOOLS_REGISTER)
    tools: List[Dict[str, Any]] = field(default_factory=list)  # Tool schemas


@dataclass
class ToolCallResponseEvent(BaseEvent):
    """Client responds to a tool call request with the result."""
    type: EventType = field(default=EventType.TOOL_CALL_RESPONSE)
    request_id: str = ""
    content: str = ""
    is_error: bool = False


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
    name: Optional[str] = None  # Speaker identity (agent name, tool name, etc.)
    persona_name: Optional[str] = None  # Persona display name
    voice_reference: Optional[str] = None
    conversation_id: int = 0
    tool_args: Optional[Dict[str, Any]] = None  # Tool input params (for tool role messages)
    tool_status: Optional[str] = None  # "success" | "error" | "denied" (for tool role messages)
    images: Optional[List[str]] = None  # Image UUIDs
    model_name: Optional[str] = None  # LLM model used
    provider_type: Optional[str] = None  # LLM provider used
    token_count: Optional[int] = None  # Running context token estimate


@dataclass
class ToolApprovalRequestEvent(BaseEvent):
    """Server requests tool approval from client."""
    type: EventType = field(default=EventType.TOOL_APPROVAL_REQUEST)
    approval_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    tool_name: str = ""
    tool_args: Dict[str, Any] = field(default_factory=dict)
    agent_id: Optional[int] = None
    name: Optional[str] = None  # Which agent is requesting approval
    description: str = ""  # Human-readable description
    execution_location: str = "backend"  # "backend" or "frontend" - where tool runs after approval


@dataclass
class ToolCallRequestEvent(BaseEvent):
    """Server forwards a tool call to the client for local execution."""
    type: EventType = field(default=EventType.TOOL_CALL_REQUEST)
    request_id: str = ""
    tool_name: str = ""
    tool_args: Dict[str, Any] = field(default_factory=dict)


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


@dataclass
class ContextInfoEvent(BaseEvent):
    """Server sends context compaction status."""
    type: EventType = field(default=EventType.CONTEXT_INFO)
    conversation_id: int = 0
    compacting: bool = False
    compacted_up_to_id: int = 0
    compacted_context: str = ""




@dataclass
class ErrorEvent(BaseEvent):
    """Server sends error."""
    type: EventType = field(default=EventType.ERROR)
    error: str = ""
    code: str = "INTERNAL_ERROR"  # INTERNAL_ERROR, CANCELLED, TIMEOUT, UNAUTHORIZED


@dataclass
class VisionResultEvent(BaseEvent):
    """Server sends vision processing results."""
    type: EventType = field(default=EventType.VISION_RESULT)
    faces: List[Dict[str, Any]] = field(default_factory=list)
    gestures: List[Dict[str, Any]] = field(default_factory=list)


# =============================================================================
# Event Parsing
# =============================================================================

def parse_event(data: Dict[str, Any]) -> BaseEvent:
    """Parse incoming JSON data into appropriate event type."""
    event_type = data.get("type")

    if event_type == EventType.CHAT_REQUEST.value:
        return ChatRequestEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            text=data.get("text", ""),
            model_name=data.get("model_name", ""),
            conversation_id=data.get("conversation_id"),
            images=data.get("images", []),
            context_files=data.get("context_files", []),
        )

    elif event_type == EventType.TOOL_APPROVAL_RESPONSE.value:
        return ToolApprovalResponseEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            approval_id=data.get("approval_id", ""),
            approved=data.get("approved", False),
            modified_args=data.get("modified_args"),
        )

    elif event_type == EventType.CANCEL.value:
        return CancelEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
        )

    elif event_type == EventType.COMPACT_CONTEXT.value:
        return CompactContextEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            conversation_id=data.get("conversation_id"),
        )

    elif event_type == EventType.VISION_START.value:
        return VisionStartEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            enable_face=data.get("enable_face", True),
            enable_pose=data.get("enable_pose", True),
            enable_hands=data.get("enable_hands", True),
        )

    elif event_type == EventType.VISION_FRAME.value:
        return VisionFrameEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            frame=data.get("frame", ""),
        )

    elif event_type == EventType.VISION_STOP.value:
        return VisionStopEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
        )

    elif event_type == EventType.CLIENT_TOOLS_REGISTER.value:
        return ClientToolsRegisterEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            tools=data.get("tools", []),
        )

    elif event_type == EventType.TOOL_CALL_RESPONSE.value:
        return ToolCallResponseEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            request_id=data.get("request_id", ""),
            content=data.get("content", ""),
            is_error=data.get("is_error", False),
        )

    else:
        raise ValueError(f"Unknown event type: {event_type}")
