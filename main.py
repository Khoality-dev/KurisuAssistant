"""Main FastAPI application setup."""

import logging
import os
from contextlib import asynccontextmanager

import dotenv
import torch
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastmcp.client import Client as FastMCPClient
from transformers import pipeline

from routers import (
    auth_router,
    chat_router,
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
    set_asr_model,
    set_mcp_client,
)
from mcp_tools.config import load_mcp_configs
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

# Load MCP configs
mcp_configs = load_mcp_configs()
mcp_client = FastMCPClient(mcp_configs) if mcp_configs.get("mcpServers") else None

# Set MCP client for the mcp router
set_mcp_client(mcp_client, mcp_configs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events - runs on startup and shutdown."""
    # Startup
    logger.info("Application starting up...")

    # Initialize MCP orchestrator globally
    init_orchestrator(mcp_client)
    logger.info("MCP orchestrator initialized")

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
    ]
)

# Configure CORS to allow Electron/React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev server
        "http://localhost:3000",  # Alternative React dev port
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize ASR model
whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
asr_model = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)
set_asr_model(asr_model)


# Health check endpoint (kept in main.py since it's simple)
@app.get("/health", tags=["health"])
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "llm-hub"}


# Include routers
app.include_router(auth_router)
app.include_router(chat_router)
app.include_router(conversations_router)
app.include_router(messages_router)
app.include_router(users_router)
app.include_router(agents_router)
app.include_router(models_router)
app.include_router(tools_router)
app.include_router(images_router)
app.include_router(tts_router)
app.include_router(mcp_router)
app.include_router(ws_router)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=15597)
