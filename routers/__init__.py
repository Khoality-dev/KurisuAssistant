"""API route handlers."""

from .auth import router as auth_router
from .chat import router as chat_router, set_asr_model
from .conversations import router as conversations_router
from .messages import router as messages_router
from .users import router as users_router
from .images import router as images_router
from .tts import router as tts_router
from .mcp import router as mcp_router, set_mcp_client
from .ws import router as ws_router
from .agents import router as agents_router

__all__ = [
    "auth_router",
    "chat_router",
    "conversations_router",
    "messages_router",
    "users_router",
    "images_router",
    "tts_router",
    "mcp_router",
    "ws_router",
    "agents_router",
    "set_asr_model",
    "set_mcp_client",
]
