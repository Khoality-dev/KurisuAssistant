"""API route handlers."""

from .auth import router as auth_router
from .asr import router as asr_router
from .conversations import router as conversations_router
from .messages import router as messages_router
from .users import router as users_router
from .images import router as images_router
from .tts import router as tts_router
from .mcp import router as mcp_router, set_mcp_client
from .ws import router as ws_router
from .agents import router as agents_router
from .models import router as models_router
from .tools import router as tools_router
from .character import router as character_router
from .vision import router as vision_router

__all__ = [
    "auth_router",
    "asr_router",
    "conversations_router",
    "messages_router",
    "users_router",
    "images_router",
    "tts_router",
    "mcp_router",
    "ws_router",
    "agents_router",
    "models_router",
    "tools_router",
    "character_router",
    "vision_router",
    "set_mcp_client",
]
