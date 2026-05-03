"""Main FastAPI application setup."""

import logging
from contextlib import asynccontextmanager

import dotenv
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from kurisuassistant.routers import (
    auth_router,
    asr_router,
    conversations_router,
    messages_router,
    users_router,
    images_router,
    tts_router,
    mcp_router,
    ws_router,
    agents_router,
    models_router,
    tools_router,
    character_router,
    vision_router,
    skills_router,
    version_router,
)
from kurisuassistant.mcp_tools.orchestrator import init_orchestrator
from kurisuassistant.version import WIRE_PROTOCOL, __version__

# Configure logging with explicit console handler
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    force=True,  # Override any existing configuration
)
logger = logging.getLogger(__name__)

dotenv.load_dotenv()

# Initialize MCP orchestrator (re-reads mcp_config.json on each cache refresh)
init_orchestrator()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events - runs on startup and shutdown."""
    # Startup — order matters: DB service first, then workers that depend on it
    logger.info("Application starting up...")
    from kurisuassistant.db.service import start_db_service, stop_db_service
    start_db_service()

    import kurisuassistant.workers as workers
    workers.start()

    yield

    # Shutdown — reverse order: stop producers, drain workers, close DB
    logger.info("Shutting down application...")
    workers.stop()
    stop_db_service()
    from kurisuassistant.db.session import engine
    engine.dispose()
    logger.info("Database connections closed")


app = FastAPI(
    lifespan=lifespan,
    title="Kurisu LLM Hub API",
    description="REST API for Kurisu Assistant LLM hub",
    version=__version__,
    openapi_tags=[
        {"name": "health", "description": "Health check and status endpoints"},
        {"name": "auth", "description": "Authentication operations"},
        {"name": "asr", "description": "Automatic speech recognition"},
        {"name": "chat", "description": "Chat and LLM operations"},
        {"name": "conversations", "description": "Conversation management"},
        {"name": "messages", "description": "Message operations"},
        {"name": "users", "description": "User profile management"},
        {"name": "agents", "description": "Agent management"},
        {"name": "tools", "description": "Tools management"},
        {"name": "mcp", "description": "MCP server management"},
        {"name": "images", "description": "Image upload and retrieval"},
        {"name": "tts", "description": "Text-to-speech synthesis"},
        {"name": "character", "description": "Character animation assets for video call"},
        {"name": "vision", "description": "Face recognition and gesture detection"},
    ]
)

# Configure CORS to allow Electron/React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev server
        "http://localhost:5174",  # Vite dev server (fallback port)
        "http://localhost:3000",  # Alternative React dev port
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health check endpoint (kept in main.py since it's simple)
@app.get("/health", tags=["health"])
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "llm-hub"}


# Endpoints exempt from wire-protocol enforcement: clients need to reach these
# even when their wire protocol is mismatched, otherwise they can't recover.
_WIRE_PROTOCOL_EXEMPT_PATHS = {"/health", "/version"}


@app.middleware("http")
async def enforce_wire_protocol(request: Request, call_next):
    """Reject 426 if `X-Wire-Protocol` header is present and doesn't match.

    Header is optional — absence is allowed (curl, browser, internal tooling).
    Clients should always send it; mismatch is a hard fail because the wire
    format is what changed and continuing would produce garbage.
    """
    if request.url.path not in _WIRE_PROTOCOL_EXEMPT_PATHS:
        client_proto = request.headers.get("x-wire-protocol")
        if client_proto is not None:
            try:
                client_proto_int = int(client_proto)
            except ValueError:
                client_proto_int = -1
            if client_proto_int != WIRE_PROTOCOL:
                return JSONResponse(
                    status_code=426,
                    content={
                        "detail": "wire_protocol_mismatch",
                        "client_wire_protocol": client_proto_int,
                        "server_wire_protocol": WIRE_PROTOCOL,
                        "backend_version": __version__,
                    },
                )
    return await call_next(request)


# Include routers
app.include_router(version_router)
app.include_router(auth_router)
app.include_router(asr_router)
app.include_router(conversations_router)
app.include_router(messages_router)
app.include_router(users_router)
app.include_router(agents_router)
app.include_router(models_router)
app.include_router(tools_router)
app.include_router(images_router)
app.include_router(tts_router)
app.include_router(character_router)
app.include_router(vision_router)
app.include_router(mcp_router)
app.include_router(skills_router)
app.include_router(ws_router)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=15597)
