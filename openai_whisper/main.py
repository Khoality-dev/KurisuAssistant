import os
from fastapi import FastAPI, WebSocketDisconnect
from fastapi import WebSocket
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

@app.websocket("/asr")
async def asr_ws(ws: WebSocket):
    await ws.accept()
    audio_buffer = bytearray()
    try:
        while True:
            msg = await ws.receive()

            # binary frame: appends raw PCM bytes
            if msg.get("bytes") is not None:
                audio_buffer.extend(msg["bytes"])

            # text frame: use "EOS" to signal end of stream
            elif msg.get("text"):
                if msg["text"] == "EOS":
                    if audio_buffer:
                        pcm = np.frombuffer(audio_buffer, dtype=np.int16)
                        waveform = pcm.astype(np.float32) / 32768.0
                        final = asr(waveform)
                        text = final["text"]
                        print("Text:", text)
                        await ws.send_text(text)
                        audio_buffer = bytearray()
                elif msg["text"] == "PING":
                    await ws.send_text("PONG")

    except WebSocketDisconnect:
        # client hung up
        pass