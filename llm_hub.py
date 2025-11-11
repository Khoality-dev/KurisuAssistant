import base64
import datetime
import json
import os

import dotenv
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Body, Depends, Form, File, UploadFile
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastmcp.client import Client as FastMCPClient
from transformers import pipeline

from sqlalchemy.orm import Session

from auth import authenticate_user, create_access_token, get_current_user
from db import operations as db_operations
from db.session import get_session
from helpers import Agent
from helpers.utils import get_current_time
from data.image_storage import operations as image_operations
from mcp_tools.client import list_tools
from mcp_tools.config import load_mcp_configs


mcp_configs = load_mcp_configs()
# Initialize mcp_client to None if no servers are configured
mcp_client = FastMCPClient(mcp_configs) if mcp_configs.get("mcpServers") else None

# MCP client uses context managers for connection management

dotenv.load_dotenv()

# Ensure the conversations table exists
db_operations.init_db()

app = FastAPI(
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

sessions = {}


# ============================================================================
# Dependencies
# ============================================================================

def get_db() -> Session:
    """Dependency to get database session."""
    with get_session() as session:
        yield session


def get_authenticated_user(token: str = Depends(oauth2_scheme)) -> str:
    """Dependency to get and validate the current user."""
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    return username


# ============================================================================
# Health & Status Endpoints
# ============================================================================

@app.get("/health", tags=["health"])
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "llm-hub"}


@app.get("/needs-admin", tags=["health"])
async def needs_admin(db: Session = Depends(get_db)):
    """Return whether the server lacks an admin account."""
    return {"needs_admin": not db_operations.admin_exists()}


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
        db_operations.create_user(form_data.username, form_data.password)
        return {"status": "ok"}
    except ValueError:
        raise HTTPException(status_code=400, detail="User already exists")
    except Exception as e:
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
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Chat & LLM Endpoints
# ============================================================================

@app.post("/chat", tags=["chat"])
async def chat(
    text: str = Form(...),
    model_name: str = Form(...),
    conversation_id: int = Form(...),
    images: list[UploadFile] = File(default=[]),
    token: str = Depends(oauth2_scheme)
):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    try:        
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
        
        # Use provided conversation_id (now required)
        conv_id = conversation_id
        
        # Create Agent instance for this conversation
        if conv_id not in sessions or len(sessions[conv_id].context_messages) == 0 or get_current_time() - datetime.datetime.fromisoformat(sessions[conv_id].context_messages[-1]["updated_at"]).replace(tzinfo=datetime.timezone.utc) >= datetime.timedelta(minutes=10):
            sessions[conv_id] = Agent(username, conv_id, mcp_client)

        agent = sessions[conv_id]
        response_generator = agent.chat(model_name, user_message_content, images=image_data)
    except Exception as e:
        print(str(e))
        raise HTTPException(status_code=500, detail=str(e))

    async def stream():
        async for chunk in response_generator:
            # Wrap the message in the expected format
            wrapped_chunk = {"message": chunk}
            yield json.dumps(wrapped_chunk) + "\n"

    return StreamingResponse(stream(), media_type="application/json")


@app.get("/models", tags=["chat"])
async def models(token: str = Depends(oauth2_scheme)):
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        # Create a temporary agent instance to get models
        temp_agent = Agent("temp", 1, mcp_client)
        return {"models": temp_agent.list_models()}
    except Exception as e:
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
        result = db_operations.get_conversations_list(username, limit)
        return result
    except Exception as e:
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
        result = db_operations.fetch_conversation(username, conversation_id, limit, offset)
        if result is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/conversations", tags=["conversations"])
async def create_conversation(
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        conversation_id = db_operations.create_new_conversation(username)
        return {"id": conversation_id, "title": "New conversation", "message_count": 0}
    except Exception as e:
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

        db_operations.update_conversation_title(username, title, conversation_id)
        return {"message": "Conversation title updated successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/conversations/{conversation_id}", tags=["conversations"])
async def delete_conversation(
    conversation_id: int,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    try:
        result = db_operations.delete_conversation_by_id(username, conversation_id)
        if result:
            return {"message": "Conversation deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Conversation not found")
    except Exception as e:
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
        result = db_operations.fetch_message_by_id(username, message_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Message not found")
        return result
    except Exception as e:
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
        system_prompt, preferred_name = db_operations.get_user_preferences(username)
        user_avatar_uuid, agent_avatar_uuid = db_operations.get_user_avatars(username)
        return {
            "username": username,
            "system_prompt": system_prompt,
            "preferred_name": preferred_name,
            "user_avatar_uuid": user_avatar_uuid,
            "agent_avatar_uuid": agent_avatar_uuid
        }
    except Exception as e:
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
            db_operations.update_user_preferences(username, system_prompt, preferred_name)

        # Handle avatar updates
        if user_avatar is not None:
            if user_avatar.size > 0:  # File was uploaded
                user_avatar_uuid = image_operations.upload_image(user_avatar)
                db_operations.update_user_avatar(username, "user", user_avatar_uuid)
            else:
                # Empty file means clear avatar
                db_operations.update_user_avatar(username, "user", None)

        if agent_avatar is not None:
            if agent_avatar.size > 0:  # File was uploaded
                agent_avatar_uuid = image_operations.upload_image(agent_avatar)
                db_operations.update_user_avatar(username, "agent", agent_avatar_uuid)
            else:
                # Empty file means clear avatar
                db_operations.update_user_avatar(username, "agent", None)

        # Get the updated avatar UUIDs to return to client
        user_avatar_uuid, agent_avatar_uuid = db_operations.get_user_avatars(username)

        return {
            "status": "ok",
            "user_avatar_uuid": user_avatar_uuid,
            "agent_avatar_uuid": agent_avatar_uuid
        }
    except Exception as e:
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