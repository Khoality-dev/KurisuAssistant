"""Main FastAPI application setup."""

import logging
from contextlib import asynccontextmanager

import dotenv
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import (
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
)
from mcp_tools.orchestrator import init_orchestrator

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
    # Startup
    logger.info("Application starting up...")

    yield

    # Shutdown: Cleanup resources
    logger.info("Shutting down application...")
    from db.session import engine
    engine.dispose()
    logger.info("Database connections closed")


app = FastAPI(
    lifespan=lifespan,
    title="Kurisu LLM Hub API",
    description="REST API for Kurisu Assistant LLM hub",
    version="0.1.0",
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


# Include routers
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
