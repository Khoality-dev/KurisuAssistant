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
    MEDIA_PLAY = "media_play"
    MEDIA_PAUSE = "media_pause"
    MEDIA_RESUME = "media_resume"
    MEDIA_SKIP = "media_skip"
    MEDIA_STOP = "media_stop"
    MEDIA_QUEUE_ADD = "media_queue_add"
    MEDIA_QUEUE_REMOVE = "media_queue_remove"
    MEDIA_VOLUME = "media_volume"

    # Server -> Client
    STREAM_CHUNK = "stream_chunk"
    TOOL_APPROVAL_REQUEST = "tool_approval_request"
    AGENT_SWITCH = "agent_switch"
    DONE = "done"
    ERROR = "error"
    VISION_RESULT = "vision_result"
    MEDIA_STATE = "media_state"
    MEDIA_CHUNK = "media_chunk"
    MEDIA_ERROR = "media_error"


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
    voice_reference: Optional[str] = None
    conversation_id: int = 0
    frame_id: int = 0
    tool_args: Optional[Dict[str, Any]] = None  # Tool input params (for tool role messages)


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


@dataclass
class VisionResultEvent(BaseEvent):
    """Server sends vision processing results."""
    type: EventType = field(default=EventType.VISION_RESULT)
    faces: List[Dict[str, Any]] = field(default_factory=list)
    gestures: List[Dict[str, Any]] = field(default_factory=list)


# =============================================================================
# Media Client -> Server Events
# =============================================================================

@dataclass
class MediaPlayEvent(BaseEvent):
    """Client requests to play media."""
    type: EventType = field(default=EventType.MEDIA_PLAY)
    query: str = ""


@dataclass
class MediaPauseEvent(BaseEvent):
    """Client requests to pause media."""
    type: EventType = field(default=EventType.MEDIA_PAUSE)


@dataclass
class MediaResumeEvent(BaseEvent):
    """Client requests to resume media."""
    type: EventType = field(default=EventType.MEDIA_RESUME)


@dataclass
class MediaSkipEvent(BaseEvent):
    """Client requests to skip current track."""
    type: EventType = field(default=EventType.MEDIA_SKIP)


@dataclass
class MediaStopEvent(BaseEvent):
    """Client requests to stop media."""
    type: EventType = field(default=EventType.MEDIA_STOP)


@dataclass
class MediaQueueAddEvent(BaseEvent):
    """Client requests to add to queue."""
    type: EventType = field(default=EventType.MEDIA_QUEUE_ADD)
    query: str = ""


@dataclass
class MediaQueueRemoveEvent(BaseEvent):
    """Client requests to remove from queue."""
    type: EventType = field(default=EventType.MEDIA_QUEUE_REMOVE)
    index: int = 0


@dataclass
class MediaVolumeEvent(BaseEvent):
    """Client sets volume."""
    type: EventType = field(default=EventType.MEDIA_VOLUME)
    volume: float = 1.0


# =============================================================================
# Media Server -> Client Events
# =============================================================================

@dataclass
class MediaStateEvent(BaseEvent):
    """Server sends media player state."""
    type: EventType = field(default=EventType.MEDIA_STATE)
    state: str = "stopped"
    current_track: Optional[Dict[str, Any]] = None
    queue: List[Dict[str, Any]] = field(default_factory=list)
    volume: float = 1.0


@dataclass
class MediaChunkEvent(BaseEvent):
    """Server sends audio data chunk."""
    type: EventType = field(default=EventType.MEDIA_CHUNK)
    data: str = ""  # base64 encoded audio
    chunk_index: int = 0
    is_last: bool = False
    format: str = "opus"
    sample_rate: int = 48000


@dataclass
class MediaErrorEvent(BaseEvent):
    """Server sends media error."""
    type: EventType = field(default=EventType.MEDIA_ERROR)
    error: str = ""


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
            agent_id=data.get("agent_id"),
            images=data.get("images", []),
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

    elif event_type == EventType.MEDIA_PLAY.value:
        return MediaPlayEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            query=data.get("query", ""),
        )

    elif event_type == EventType.MEDIA_PAUSE.value:
        return MediaPauseEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
        )

    elif event_type == EventType.MEDIA_RESUME.value:
        return MediaResumeEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
        )

    elif event_type == EventType.MEDIA_SKIP.value:
        return MediaSkipEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
        )

    elif event_type == EventType.MEDIA_STOP.value:
        return MediaStopEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
        )

    elif event_type == EventType.MEDIA_QUEUE_ADD.value:
        return MediaQueueAddEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            query=data.get("query", ""),
        )

    elif event_type == EventType.MEDIA_QUEUE_REMOVE.value:
        return MediaQueueRemoveEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            index=data.get("index", 0),
        )

    elif event_type == EventType.MEDIA_VOLUME.value:
        return MediaVolumeEvent(
            event_id=data.get("event_id", str(uuid.uuid4())),
            timestamp=data.get("timestamp", datetime.utcnow().isoformat() + "Z"),
            volume=data.get("volume", 1.0),
        )

    else:
        raise ValueError(f"Unknown event type: {event_type}")
