import asyncio
import datetime
import json
import os
import re
import subprocess
import wave
from helpers.llm import OllamaClient
from fastapi import FastAPI, Request, HTTPException, Response, Body, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from transformers import pipeline
from helpers.tts import TTS
from auth import get_current_user, authenticate_user, create_access_token
import torch
import numpy as np
import requests
import dotenv
from fastmcp.client import Client as FastMCPClient
import glob

# Load MCP configs from tool-specific config.json files
def load_mcp_configs():
    mcp_servers = {}
    tool_config_files = glob.glob("mcp_tools/*/config.json")
    for config_file in tool_config_files:
        try:
            with open(config_file, "r") as f:
                tool_config = json.load(f)
                tool_mcp_servers = tool_config.get("mcp_servers", {})
                mcp_servers.update(tool_mcp_servers)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            print(f"Warning: Could not load MCP config from {config_file}: {e}")
    return {"mcpServers": mcp_servers}

mcp_configs = load_mcp_configs()
# Initialize mcp_client to None if no servers are configured
mcp_client = FastMCPClient(mcp_configs) if mcp_configs.get("mcpServers") else None
dotenv.load_dotenv()

app = FastAPI(
    title="Kurisu Assistant Core API",
    description="API for Kurisu Assistant Core",
    version="0.1.0"
)

whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
asr_model = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)
tts_model = TTS()
SAMPLE_RATE = 16_000         # Hz
SAMPLE_WIDTH = 2             # bytes per sample (16-bit)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")


@app.post("/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    if authenticate_user(form_data.username, form_data.password):
        token = create_access_token({"sub": form_data.username})
        return {"access_token": token, "token_type": "bearer"}
    raise HTTPException(status_code=400, detail="Incorrect username or password")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    # Authenticate
    try:
        data = await asyncio.wait_for(ws.receive(), timeout=5.0)
        if data.get("text") is not None:
            token = data["text"]
            if not get_current_user(token):
                print("Invalid token")
                await ws.close()
                return
            print("Authenticated")
    except Exception:
        print("Failed to authenticate")
        await ws.close()
        return
    
    ollama_client = OllamaClient(mcp_client)
    try:
        while True:
            data = await ws.receive()
            if data.get("text") is not None:
                # Client is sending an LLM request encoded as a JSON string
                text_payload = data["text"]
                json_body = json.loads(text_payload)
                response_generator = ollama_client.chat(json_body)
                async for response in response_generator:
                    audio_data = tts_model(response["message"]["content"])
                    await ws.send_text(json.dumps(response))
                    if audio_data is None:
                        audio_data = b''
                    await ws.send_bytes(audio_data)

            elif data.get("bytes") is not None:
                # Raw PCM audio from the client for speech recognition
                audio_data = data["bytes"]
                pcm = np.frombuffer(audio_data, dtype=np.int16)
                waveform = pcm.astype(np.float32) / 32768.0

                # 2) Run your ASR model
                result = asr_model(waveform)   # assuming `asr` is your pipeline
                text_payload = result["text"]
                print("ASR Result: ", text_payload)
                # Send the transcribed text back to the client. The client will
                # then forward it as a JSON chat request for LLM inference.
                json_body = {"text": text_payload}
                await ws.send_text(json.dumps(json_body))
    except WebSocketDisconnect:
        print("WebSocket disconnected")


# Decrecated, changed to use WebSocket instead
# @app.post(
#     "/asr",
#     responses={200: {"content": {"application/json": {}}}}
# )
# async def asr(
#     audio: bytes = Body(..., media_type="application/octet-stream")
# ):
#     """
#     Receive raw int16 PCM in the request body,
#     convert to float waveform, run ASR, and return JSON.
#     """
#     try:
#         # 1) Convert raw bytes → int16 PCM → float32 waveform
#         pcm = np.frombuffer(audio, dtype=np.int16)
#         waveform = pcm.astype(np.float32) / 32768.0

#         # 2) Run your ASR model
#         result = asr_model(waveform)   # assuming `asr` is your pipeline
#         text = result["text"]
#         print("ASR Result: ", text)
#         # 3) Return JSON
#         return {"text": text}

#     except Exception as e:
#         # Something went wrong during decoding or ASR
#         raise HTTPException(status_code=500, detail=str(e))

# @app.post("/chat")
# async def chat_proxy(request: Request):
#     # 1. Read the incoming JSON and ensure streaming is enabled
#     payload = await request.json()
#     payload["model"] = "qwen2.5:7b"
#     #payload["messages"][-1]['content'] += "/no_think"
#     try:
#         response_generator = llm_model(payload)
#     except Exception as e:
#         print(str(e))
#         raise HTTPException(status_code=500, detail=str(e))
#     return StreamingResponse(
#         response_generator,
#         media_type="application/json"
#     )

# @app.post(
#     "/tts",
#     response_class=Response,
#     responses={200: {"content": {"application/octet-stream": {}}}}
# )
# async def tts(
#     text: str = Body(..., embed=True)
# ):
#     """
#     Receive text, run TTS, and return raw audio bytes.
#     """
#     print("Received text: ", text)
#     result = tts_model(text)
#     if result is None:
#         raise HTTPException(status_code=500, detail="TTS Error")
#     return Response(content=result, media_type="apllication/octet-stream")
