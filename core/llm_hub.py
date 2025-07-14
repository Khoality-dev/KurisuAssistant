import json
import os
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Body, Response, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from transformers import pipeline
import torch
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
)

with open("configs/default.json", "r") as f:
    json_config = json.load(f)
    mcp_configs = {"mcpServers": json_config.get("mcp_servers", {})}

mcp_client = FastMCPClient(mcp_configs)

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
        add_message(
            username,
            "user",
            payload["message"]["content"],
            None,
            llm_model.system_prompts,
        )
        response_generator = llm_model(payload)
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
                add_message(username, "assistant", full_response, payload.get("model"))
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
