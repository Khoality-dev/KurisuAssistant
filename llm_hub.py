import base64
import datetime
import json
import logging
import os
from contextlib import asynccontextmanager

import dotenv
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Body, Depends, Form, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastmcp.client import Client as FastMCPClient
from transformers import pipeline

from sqlalchemy.orm import Session

from auth import authenticate_user, create_access_token, get_current_user
from db import services as db_services
from db.session import get_session
import llm_adapter
from context import manager as context_manager
from prompts import builder as prompt_builder
from helpers.utils import get_current_time
from data.image_storage import operations as image_operations
from mcp_tools.client import list_tools
from mcp_tools.config import load_mcp_configs
from mcp_tools.orchestrator import init_orchestrator, get_orchestrator

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

dotenv.load_dotenv()

mcp_configs = load_mcp_configs()
# Initialize mcp_client to None if no servers are configured
mcp_client = FastMCPClient(mcp_configs) if mcp_configs.get("mcpServers") else None


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
        {"name": "mcp", "description": "MCP server management"},
        {"name": "images", "description": "Image upload and retrieval"},
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

# We'll create Agent instances per request now since they need username/conversation_id
whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'

# Image storage handled by separate image-storage service
asr_model = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)
SAMPLE_RATE = 16_000

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")


# ============================================================================
# Dependencies
# ============================================================================

def get_db() -> Session:
    """Dependency to get database session."""
    with get_session() as session:
        yield session


def get_authenticated_user(token: str = Depends(oauth2_scheme)) -> str:
    """Dependency to get and validate the current user."""
    # BYPASS AUTH: Always return admin for development
    return "admin"

    # Original auth code (disabled):
    # username = get_current_user(token)
    # if not username:
    #     raise HTTPException(status_code=401, detail="Invalid token")
    # return username


# ============================================================================
# Health & Status Endpoints
# ============================================================================

@app.get("/health", tags=["health"])
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "llm-hub"}


# ============================================================================
# Authentication Endpoints
# ============================================================================

@app.post("/login", tags=["auth"])
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    if authenticate_user(form_data.username, form_data.password):
        token = create_access_token({"sub": form_data.username})
        return {"access_token": token, "token_type": "bearer"}
    raise HTTPException(status_code=400, detail="Incorrect username or password")


@app.post("/register", tags=["auth"])
async def register(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    try:
        db_services.create_user(form_data.username, form_data.password)
        return {"status": "ok"}
    except ValueError:
        raise HTTPException(status_code=400, detail="User already exists")
    except Exception as e:
        logger.error(f"Error registering user {form_data.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Speech-to-Text Endpoint
# ============================================================================

@app.post("/asr", tags=["asr"])
async def asr(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    token: str = Depends(oauth2_scheme),
):
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        pcm = np.frombuffer(audio, dtype=np.int16)
        waveform = pcm.astype(np.float32) / 32768.0
        result = asr_model(waveform)
        text = result["text"]
        return {"text": text}
    except Exception as e:
        logger.error(f"Error processing ASR request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Chat & LLM Endpoints
# ============================================================================

@app.post("/chat", tags=["chat"])
async def chat(
    text: str = Form(...),
    model_name: str = Form(...),
    conversation_id: int = Form(None),  # None = create new conversation
    images: list[UploadFile] = File(default=[]),
    token: str = Depends(oauth2_scheme)
):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        # Auto-create conversation if needed
        if conversation_id is None:
            actual_conversation_id = db_services.create_new_conversation(username)
        else:
            actual_conversation_id = conversation_id

        user_message_content = text
        image_data = []

        # Handle image attachments if provided
        if images:
            valid_images = [img for img in images if img.size > 0]  # Filter out empty files
            if valid_images:
                image_markdowns = []
                for image in valid_images:
                    # Upload image and get UUID for frontend display
                    image_uuid = image_operations.upload_image(image)
                    image_url = f"/images/{image_uuid}"
                    # Add image in markdown format for frontend display
                    image_markdowns.append(f"![Image]({image_url})")

                    # Convert image to base64 for agent processing
                    image.file.seek(0)  # Reset file pointer
                    image_bytes = await image.read()
                    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
                    image_data.append(image_b64)

                # Include image markdown in the message content
                if image_markdowns:
                    images_text = "\n\n" + "\n".join(image_markdowns)
                    user_message_content += images_text

        # Always use latest chunk or create new if conversation is empty
        last_chunk = db_services.get_latest_chunk(username, actual_conversation_id)
        actual_chunk_id = last_chunk["id"] if last_chunk else db_services.create_chunk(username, actual_conversation_id)

    except Exception as e:
        logger.error(f"Error preparing chat request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    # Store IDs for streaming response
    current_conversation_id = actual_conversation_id
    current_chunk_id = actual_chunk_id

    # 1. Load context from database
    context_messages = context_manager.get_chunk_messages(
        username=username,
        conversation_id=current_conversation_id,
        chunk_id=current_chunk_id
    )

    # 2. Get user preferences and build system prompts
    user_system_prompt, preferred_name = db_services.get_user_preferences(username)
    system_messages = prompt_builder.build_system_messages(user_system_prompt, preferred_name)

    # 3. Create user message
    created_at = datetime.datetime.utcnow().isoformat()
    user_message = {
        "role": "user",
        "content": user_message_content,
        "created_at": created_at,
    }

    # 4. Build full message list for LLM
    messages = system_messages + context_messages + [user_message]

    # 5. Get tools from orchestrator
    # DEBUG: Comment out MCP tools
    # orchestrator = get_orchestrator()
    # tools = await orchestrator.get_tools()
    tools = []

    # 6. Call llm_adapter to get sentence-chunked stream
    sentence_stream = llm_adapter.chat(
        model_name=model_name,
        messages=messages,
        tools=tools,
        images=image_data
    )

    def stream():
        try:
            # Concatenate all assistant responses
            complete_content = ""
            complete_thinking = None
            last_created_at = None

            # Iterate over sentence-chunked stream from llm_adapter
            for message in sentence_stream:
                # Yield to frontend
                wrapped_chunk = {
                    "message": message,
                    "conversation_id": current_conversation_id,
                    "chunk_id": current_chunk_id
                }
                yield json.dumps(wrapped_chunk) + "\n"

                # Concatenate for database
                complete_content += message.get("content", "")
                last_created_at = message.get("created_at")

                # Capture thinking from the message (only last message will have it)
                if message.get("thinking"):
                    if complete_thinking is None:  # First message with thinking
                        complete_thinking = message.get("thinking")
                    else:  # Merge thinking from multiple messages
                        complete_thinking += message.get("thinking")

            # Save messages to database after streaming completes
            # Save user message first
            try:
                db_services.create_message(username, user_message, current_conversation_id, current_chunk_id)
            except Exception as e:
                logger.error(f"Failed to save user message: {e}")

            # Save complete assistant response as one message
            if complete_content:
                complete_message = {
                    "role": "assistant",
                    "content": complete_content,
                    "created_at": last_created_at
                }
                # Include thinking if captured
                if complete_thinking:
                    complete_message["thinking"] = complete_thinking
                try:
                    db_services.create_message(username, complete_message, current_conversation_id, current_chunk_id)
                except Exception as e:
                    logger.error(f"Failed to save assistant message: {e}")

            # Send "done" signal to frontend
            done_chunk = {"done": True}
            yield json.dumps(done_chunk) + "\n"

        except Exception as e:
            logger.error(f"Error in chat stream: {e}")
            error_msg = {
                "message": {
                    "role": "assistant",
                    "content": f"Error: {str(e)}",
                    "created_at": datetime.datetime.utcnow().isoformat(),
                }
            }
            yield json.dumps(error_msg) + "\n"
            # Send "done" signal even on error
            done_chunk = {"done": True}
            yield json.dumps(done_chunk) + "\n"

    return StreamingResponse(
        stream(),
        media_type="application/json"
    )


@app.get("/models", tags=["chat"])
async def models(token: str = Depends(oauth2_scheme)):
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return {"models": llm_adapter.list_models()}
    except Exception as e:
        logger.error(f"Error fetching models from LLM provider: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Conversation Endpoints
# ============================================================================

@app.get("/conversations", tags=["conversations"])
async def list_conversations(
    limit: int = 50,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        result = db_services.get_conversations_list(username, limit)
        return result
    except Exception as e:
        logger.error(f"Error listing conversations for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations/{conversation_id}", tags=["conversations"])
async def get_conversation(
    conversation_id: int,
    limit: int = 50,
    offset: int = 0,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        result = db_services.fetch_conversation(username, conversation_id, limit, offset)
        if result is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching conversation {conversation_id} for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/conversations/{conversation_id}", tags=["conversations"])
async def update_conversation(
    conversation_id: int,
    request: Request,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        payload = await request.json()
        title = payload.get("title")

        if not title:
            raise HTTPException(status_code=400, detail="Title is required")

        db_services.update_conversation_title(username, title, conversation_id)
        return {"message": "Conversation title updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating conversation {conversation_id} for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/conversations/{conversation_id}", tags=["conversations"])
async def delete_conversation(
    conversation_id: int,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        result = db_services.delete_conversation_by_id(username, conversation_id)
        if result:
            return {"message": "Conversation deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Conversation not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting conversation {conversation_id} for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations/{conversation_id}/chunks", tags=["conversations"])
async def list_chunks(
    conversation_id: int,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List all chunks in a conversation with metadata."""
    try:
        chunks = db_services.get_chunks_by_conversation(username, conversation_id)
        if chunks is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {"chunks": chunks}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing chunks for conversation {conversation_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Message Endpoints
# ============================================================================

@app.get("/messages/{message_id}", tags=["messages"])
async def get_message(
    message_id: int,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Fetch a specific message by its ID."""
    try:
        result = db_services.fetch_message_by_id(username, message_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Message not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching message {message_id} for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# User Profile Endpoints
# ============================================================================

@app.get("/users/me", tags=["users"])
async def get_user_profile(
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        system_prompt, preferred_name = db_services.get_user_preferences(username)
        user_avatar_uuid, agent_avatar_uuid = db_services.get_user_avatars(username)
        return {
            "username": username,
            "system_prompt": system_prompt,
            "preferred_name": preferred_name,
            "user_avatar_uuid": user_avatar_uuid,
            "agent_avatar_uuid": agent_avatar_uuid
        }
    except Exception as e:
        logger.error(f"Error fetching user profile for {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/users/me", tags=["users"])
async def update_user_profile(
    system_prompt: str = Form(None),
    preferred_name: str = Form(None),
    user_avatar: UploadFile = File(None),
    agent_avatar: UploadFile = File(None),
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        # Update preferences using the combined function
        if system_prompt is not None or preferred_name is not None:
            db_services.update_user_preferences(username, system_prompt, preferred_name)

        # Handle avatar updates
        if user_avatar is not None:
            if user_avatar.size > 0:  # File was uploaded
                user_avatar_uuid = image_operations.upload_image(user_avatar)
                db_services.update_user_avatar(username, "user", user_avatar_uuid)
            else:
                # Empty file means clear avatar
                db_services.update_user_avatar(username, "user", None)

        if agent_avatar is not None:
            if agent_avatar.size > 0:  # File was uploaded
                agent_avatar_uuid = image_operations.upload_image(agent_avatar)
                db_services.update_user_avatar(username, "agent", agent_avatar_uuid)
            else:
                # Empty file means clear avatar
                db_services.update_user_avatar(username, "agent", None)

        # Get the updated avatar UUIDs to return to client
        user_avatar_uuid, agent_avatar_uuid = db_services.get_user_avatars(username)

        return {
            "status": "ok",
            "user_avatar_uuid": user_avatar_uuid,
            "agent_avatar_uuid": agent_avatar_uuid
        }
    except Exception as e:
        logger.error(f"Error updating user profile for {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# MCP Server Endpoints
# ============================================================================

@app.get("/mcp-servers", tags=["mcp"])
async def mcp_servers(
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        servers = []
        for name, config in mcp_configs.get("mcpServers", {}).items():
            server_info = {
                "name": name,
                "command": config.get("command", ""),
                "args": config.get("args", []),
                "status": "configured"
            }
            servers.append(server_info)
        
        # Try to get tools from each server to show availability
        if mcp_client is not None:
            try:
                tools = await list_tools(mcp_client)
                available_servers = set()
                for tool in tools:
                    server_name = tool.get("server", "unknown")
                    available_servers.add(server_name)
                
                for server in servers:
                    if server["name"] in available_servers:
                        server["status"] = "available"
                    else:
                        server["status"] = "unavailable"
            except Exception:
                # If we can't get tools, just mark as configured
                pass

        return {"servers": servers}
    except Exception as e:
        logger.error(f"Error fetching MCP servers: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Image Endpoints
# ============================================================================

@app.post("/images", tags=["images"])
async def create_image(
    file: UploadFile = File(...),
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Upload image and return UUID."""
    image_uuid = image_operations.upload_image(file)
    return {"image_uuid": image_uuid, "url": f"/images/{image_uuid}"}


@app.get("/images/{image_uuid}", tags=["images"])
async def get_image(image_uuid: str):
    """Serve image publicly."""
    
    image_path = image_operations.get_image_path(image_uuid)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")
    
    # Determine media type based on file extension
    media_type = "image/jpeg" if image_path.suffix.lower() == ".jpg" else "image/png"
    
    return FileResponse(
        path=image_path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"}
    )




if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=15597)