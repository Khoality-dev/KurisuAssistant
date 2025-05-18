import json
import os
from fastapi import FastAPI, WebSocketDisconnect
from fastapi import WebSocket
import numpy as np

from helpers.agent import Agent
from openai_whisper.stt import ASR

app = FastAPI(
    title="Kurisu Assistant API",
    description="API for Kurisu Assistant",
    version="0.1.0"
)

whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
asr = ASR(whisper_model_name)
agent = Agent()

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

class message:
    def __init__(self, role, content):
        self.role = role
        self.content = content


@app.post("/chat")
async def chat(message: message):
    agent(message.content)