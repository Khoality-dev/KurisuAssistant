"""Mock Ollama server for tests and for driving a client without a real model.

See ``server.py`` for what it speaks and how to script it.
"""

from .server import (  # noqa: F401
    CONTEXT_LENGTH,
    DEFAULT_MODEL,
    EMBED_DIMENSIONS,
    MockOllamaServer,
    MockOllamaState,
    Reply,
    ToolCall,
    create_app,
    default_embedding,
    default_reply,
)

__all__ = [
    "CONTEXT_LENGTH",
    "DEFAULT_MODEL",
    "EMBED_DIMENSIONS",
    "MockOllamaServer",
    "MockOllamaState",
    "Reply",
    "ToolCall",
    "create_app",
    "default_embedding",
    "default_reply",
]
