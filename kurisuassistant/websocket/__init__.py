"""WebSocket handling for real-time chat."""

from .events import (
    EventType,
    ConnectedEvent,
    ChatRequestEvent,
    StreamChunkEvent,
    ToolApprovalRequestEvent,
    ToolApprovalResponseEvent,
    AgentSwitchEvent,
    DoneEvent,
    ErrorEvent,
    CancelEvent,
    parse_event,
)

__all__ = [
    "EventType",
    "ConnectedEvent",
    "ChatRequestEvent",
    "StreamChunkEvent",
    "ToolApprovalRequestEvent",
    "ToolApprovalResponseEvent",
    "AgentSwitchEvent",
    "DoneEvent",
    "ErrorEvent",
    "CancelEvent",
    "parse_event",
]
