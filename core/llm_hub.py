import json
import os
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Body, Response
from fastapi.responses import StreamingResponse
from transformers import pipeline
import torch
from helpers.llm import LLM
import dotenv
from fastmcp.client import Client as FastMCPClient

with open("configs/default.json", "r") as f:
    json_config = json.load(f)
    mcp_configs = {"mcpServers": json_config.get("mcp_servers", {})}

mcp_client = FastMCPClient(mcp_configs)

dotenv.load_dotenv()

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

@app.post("/asr")
async def asr(audio: bytes = Body(..., media_type="application/octet-stream")):
    try:
        pcm = np.frombuffer(audio, dtype=np.int16)
        waveform = pcm.astype(np.float32) / 32768.0
        result = asr_model(waveform)
        text = result["text"]
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat")
async def chat(request: Request):
    payload = await request.json()
    try:
        response_generator = llm_model(payload)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return StreamingResponse(response_generator, media_type="application/json")
