import datetime
import json
import os
import re
import subprocess
import wave
from fastapi import FastAPI, Request, HTTPException, Response, Body
from fastapi.responses import StreamingResponse
from transformers import pipeline
from helpers.tts import TTS
from helpers.llm import LLM
import torch
import numpy as np
import requests
import dotenv

dotenv.load_dotenv()

app = FastAPI(
    title="Kurisu Assistant Core API",
    description="API for Kurisu Assistant Core",
    version="0.1.0"
)

whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
print("Whiser: ", whisper_model_name)
asr_model = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)
tts_model = TTS()
llm_model = LLM()

SAMPLE_RATE = 16_000         # Hz
SAMPLE_WIDTH = 2             # bytes per sample (16-bit)


@app.post(
    "/asr",
    responses={200: {"content": {"application/json": {}}}}
)
async def asr(
    audio: bytes = Body(..., media_type="application/octet-stream")
):
    """
    Receive raw int16 PCM in the request body,
    convert to float waveform, run ASR, and return JSON.
    """
    try:
        # 1) Convert raw bytes → int16 PCM → float32 waveform
        pcm = np.frombuffer(audio, dtype=np.int16)
        waveform = pcm.astype(np.float32) / 32768.0

        # 2) Run your ASR model
        result = asr_model(waveform)   # assuming `asr` is your pipeline
        text = result["text"]
        print("ASR Result: ", text)
        # 3) Return JSON
        return {"text": text}

    except Exception as e:
        # Something went wrong during decoding or ASR
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat")
async def chat_proxy(request: Request):
    # 1. Read the incoming JSON and ensure streaming is enabled
    payload = await request.json()
    try:
        response_generator = llm_model(payload)
    except Exception as e:
        print(str(e))
        raise HTTPException(status_code=500, detail=str(e))
    return StreamingResponse(
        response_generator,
        media_type="application/json"
    )

@app.post(
    "/tts",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}}
)
async def tts(
    text: str = Body(..., embed=True)
):
    """
    Receive text, run TTS, and return raw audio bytes.
    """
    print("Received text: ", text)
    result = tts_model(text)
    if result is None:
        raise HTTPException(status_code=500, detail="TTS Error")
    return Response(content=result, media_type="apllication/octet-stream")