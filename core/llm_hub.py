import json
import os
import glob
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Body, Response, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from transformers import pipeline
import torch
import uvicorn
from helpers.llm import LLM
import dotenv
from fastmcp.client import Client as FastMCPClient
from auth import authenticate_user, create_access_token, get_current_user
from db import (
    init_db,
    add_message,
    get_history,
    create_user,
    admin_exists,
    get_user_system_prompt,
    update_user_system_prompt,
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

dotenv.load_dotenv()

# Ensure the conversations table exists
init_db()

app = FastAPI(
    title="Kurisu LLM Hub API",
    description="REST API for Kurisu Assistant LLM hub",
    version="0.1.0",
)

llm_model = LLM(mcp_client)
whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
asr_model = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)
SAMPLE_RATE = 16_000

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")


@app.get("/needs-admin")
async def needs_admin():
    """Return whether the server lacks an admin account."""
    return {"needs_admin": not admin_exists()}


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
async def chat(request: Request, token: str = Depends(oauth2_scheme)):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    payload = await request.json()
    try:
        # Get user-specific system prompt
        user_system_prompt = get_user_system_prompt(username)
        
        # Create user system prompts list
        user_system_prompts = llm_model.system_prompts.copy()
        if user_system_prompt:
            user_system_prompts.append({
                "role": "system",
                "content": user_system_prompt
            })
        
        add_message(
            username,
            "user",
            payload["message"]["content"],
            None,
            user_system_prompts,
        )
        response_generator = llm_model(payload, user_system_prompts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    async def stream():
        full_response = ""
        async for chunk in response_generator:
            msg = chunk.get("message", {})
            if msg.get("role") == "tool":
                add_message(username, "tool", msg["content"])
                yield json.dumps(chunk) + "\n"
                continue

            content = msg.get("content", "")
            full_response += content
            # send each chunk on its own line so clients can parse with
            # readUtf8Line without waiting for the whole stream
            yield json.dumps(chunk) + "\n"

            if msg.get("tool_calls"):
                add_message(
                    username,
                    "assistant",
                    full_response,
                    payload.get("model"),
                    tool_calls=msg.get("tool_calls"),
                )
                full_response = ""
                continue

            if chunk.get("done"):
                add_message(
                    username,
                    "assistant",
                    full_response,
                    payload.get("model"),
                )
                full_response = ""

    return StreamingResponse(stream(), media_type="application/json")


@app.get("/models")
async def models(token: str = Depends(oauth2_scheme)):
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return {"models": llm_model.list_models()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/history")
async def history(token: str = Depends(oauth2_scheme), limit: int = 50):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return get_history(username, limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/system-prompt")
async def get_system_prompt(token: str = Depends(oauth2_scheme)):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        system_prompt = get_user_system_prompt(username)
        return {"system_prompt": system_prompt}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/system-prompt")
async def update_system_prompt(
    request: Request, token: str = Depends(oauth2_scheme)
):
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        payload = await request.json()
        system_prompt = payload.get("system_prompt", "")
        update_user_system_prompt(username, system_prompt)
        return {"status": "ok"}
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
                from helpers.llm import list_tools
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