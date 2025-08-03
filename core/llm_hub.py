import datetime
import json
import os
import glob
import numpy as np
from typing import Dict, List, Any
from fastapi import FastAPI, HTTPException, Request, Body, Response, Depends, Form
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from transformers import pipeline
import torch
import uvicorn
from helpers.utils import get_current_time
from mcp_tools.client import list_tools
from helpers import Agent
import dotenv
from fastmcp.client import Client as FastMCPClient
from auth import authenticate_user, create_access_token, get_current_user
from helpers.db import (
    init_db,
    add_messages,
    fetch_conversation,
    fetch_message_by_id,
    create_user,
    admin_exists,
    get_user_system_prompt,
    update_user_system_prompt,
    get_user_preferred_name,
    update_user_preferred_name,
    update_conversation_title,
    delete_conversation_by_id,
    get_conversations_list,
    create_new_conversation,
    get_db_connection,
)

def load_mcp_configs():
    """Load and merge MCP configurations from tool-specific config.json files."""
    # Start with empty configuration - no more default.json
    mcp_servers = {}
     
    # Find and merge tool-specific configurations
    current_dir = os.path.dirname(os.path.abspath(__file__))
    tool_config_files = glob.glob(os.path.join(current_dir, "mcp_tools/*/config.json"))
    for config_file in tool_config_files:
        try:
            with open(config_file, "r") as f:
                tool_config = json.load(f)
                tool_mcp_servers = tool_config.get("mcp_servers", {})
                # Merge tool-specific servers into main configuration
                mcp_servers.update(tool_mcp_servers)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            print(f"Warning: Could not load MCP config from {config_file}: {e}")
    
    return {"mcpServers": mcp_servers}

mcp_configs = load_mcp_configs()
# Initialize mcp_client to None if no servers are configured
mcp_client = FastMCPClient(mcp_configs) if mcp_configs.get("mcpServers") else None

# MCP client uses context managers for connection management

dotenv.load_dotenv()

# Ensure the conversations table exists
init_db()

app = FastAPI(
    title="Kurisu LLM Hub API",
    description="REST API for Kurisu Assistant LLM hub",
    version="0.1.0",
)

# We'll create Agent instances per request now since they need username/conversation_id
whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
asr_model = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)
SAMPLE_RATE = 16_000

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

sessions = {}

@app.get("/needs-admin")
async def needs_admin():
    """Return whether the server lacks an admin account."""
    return {"needs_admin": not admin_exists()}


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "llm-hub"}


@app.post("/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    if authenticate_user(form_data.username, form_data.password):
        token = create_access_token({"sub": form_data.username})
        return {"access_token": token, "token_type": "bearer"}
    raise HTTPException(status_code=400, detail="Incorrect username or password")


@app.post("/register")
async def register(form_data: OAuth2PasswordRequestForm = Depends()):
    try:
        create_user(form_data.username, form_data.password)
        return {"status": "ok"}
    except ValueError:
        raise HTTPException(status_code=400, detail="User already exists")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/asr")
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

@app.post("/chat")
async def chat(
    text: str = Form(...),
    model_name: str = Form(...),
    conversation_id: int = Form(...),
    token: str = Depends(oauth2_scheme)
):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    try:        
        user_message_content = text
        
        # Use provided conversation_id (now required)
        conv_id = conversation_id
        
        # Create Agent instance for this conversation
        if conv_id not in sessions or len(sessions[conv_id].context_messages) == 0 or get_current_time() - datetime.datetime.fromisoformat(sessions[conv_id].context_messages[-1]["updated_at"]).replace(tzinfo=datetime.timezone.utc) >= datetime.timedelta(minutes=10):
            sessions[conv_id] = Agent(username, conv_id, mcp_client)

        agent = sessions[conv_id]
        response_generator = agent.chat(model_name, user_message_content)
    except Exception as e:
        print(str(e))
        raise HTTPException(status_code=500, detail=str(e))

    async def stream():
        async for chunk in response_generator:
            # Wrap the message in the expected format
            wrapped_chunk = {"message": chunk}
            yield json.dumps(wrapped_chunk) + "\n"

    return StreamingResponse(stream(), media_type="application/json")


@app.get("/models")
async def models(token: str = Depends(oauth2_scheme)):
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        # Create a temporary agent instance to get models
        temp_agent = Agent("temp", 1, mcp_client)
        return {"models": temp_agent.list_models()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: int, 
    limit: int = 50, 
    offset: int = 0, 
    token: str = Depends(oauth2_scheme)
):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        result = fetch_conversation(username, conversation_id, limit, offset)
        if result is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/messages/{message_id}")
async def get_message(
    message_id: int,
    token: str = Depends(oauth2_scheme)
):
    """Fetch a specific message by its ID."""
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        result = fetch_message_by_id(username, message_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Message not found")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations")
async def list_conversations(token: str = Depends(oauth2_scheme), limit: int = 50):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        result = get_conversations_list(username, limit)
        return result
    except Exception as e:
        print(str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/conversations")
async def create_conversation(token: str = Depends(oauth2_scheme)):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        conversation_id = create_new_conversation(username)
        return {"id": conversation_id, "title": "New conversation", "message_count": 0}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/conversations/{conversation_id}")
async def update_conversation(conversation_id: int, request: Request, token: str = Depends(oauth2_scheme)):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    try:
        payload = await request.json()
        title = payload.get("title")
        
        if not title:
            raise HTTPException(status_code=400, detail="Title is required")
        
        update_conversation_title(username, title, conversation_id)
        return {"message": "Conversation title updated successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/conversation/{conversation_id}")
async def delete_conversation(conversation_id: int, token: str = Depends(oauth2_scheme)):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        result = delete_conversation_by_id(username, conversation_id)
        if result:
            return {"message": "Conversation deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Conversation not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@app.get("/user")
async def get_user_profile(token: str = Depends(oauth2_scheme)):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        system_prompt = get_user_system_prompt(username)
        preferred_name = get_user_preferred_name(username)
        return {
            "username": username,
            "system_prompt": system_prompt,
            "preferred_name": preferred_name
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/user")
async def update_user_profile(
    request: Request, token: str = Depends(oauth2_scheme)
):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        payload = await request.json()
        
        # Update system prompt if provided
        if "system_prompt" in payload:
            system_prompt = payload.get("system_prompt", "")
            update_user_system_prompt(username, system_prompt)
        
        # Update preferred name if provided
        if "preferred_name" in payload:
            preferred_name = payload.get("preferred_name", "")
            update_user_preferred_name(username, preferred_name)
        
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate")
async def generate(
    request: Request, token: str = Depends(oauth2_scheme)
):
    """Generate text for the given prompt using Ollama's generate API."""
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    try:
        data = await request.json()
        prompt = data.get("prompt", "")
        model = data.get("model", "anhkhoan/gemma3:latest")
        max_tokens = data.get("max_tokens", 50)
        
        if not prompt:
            raise HTTPException(status_code=400, detail="Prompt is required")
        
        # Prepare system prompts
        user_system_prompt = get_user_system_prompt(username)
        user_system_prompts = []
        if user_system_prompt:
            user_system_prompts.append({
                "role": "system",
                "content": user_system_prompt
            })
        
        # Prepare payload for generate method
        generate_payload = {
            "message": {"content": prompt},
            "model": model,
            "options": {
                "num_predict": max_tokens,
                "temperature": 0.7,
                "stop": ["\n", ".", "?", "!"]
            }
        }
        
        # Create temporary agent for generation
        temp_agent = Agent(username, 1, mcp_client)
        content = temp_agent.generate(generate_payload, user_system_prompts)
        
        return {"response": content}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/mcp-servers")
async def mcp_servers(token: str = Depends(oauth2_scheme)):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
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


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=15597)