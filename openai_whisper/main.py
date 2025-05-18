import os
from fastapi import FastAPI, HTTPException, WebSocketDisconnect
from fastapi import WebSocket, Body
from transformers import pipeline
import torch
import numpy as np

app = FastAPI(
    title="OpenAI Whisper API",
    description="API for OpenAI Whisper model",
    version="0.0.0"
)

whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
asr = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)

SAMPLE_RATE = 16_000         # Hz
SAMPLE_WIDTH = 2             # bytes per sample (16-bit)


@app.post(
    "/asr",
    responses={200: {"content": {"application/json": {}}}}
)
async def asr_post(
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
        result = asr(waveform)   # assuming `asr` is your pipeline
        text = result["text"]

        # 3) Return JSON
        return {"text": text}

    except Exception as e:
        # Something went wrong during decoding or ASR
        raise HTTPException(status_code=500, detail=str(e))