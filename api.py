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

@app.websocket("/chat")
async def talk_ws(ws: WebSocket):
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
                        text = asr(waveform)
                        print("Text:", text)
                        for text, audio in agent(text):
                            await ws.send_text(text)
                            if audio is not None:
                                await ws.send_bytes(audio.tobytes())
                            await ws.send_text("EOS")

                        audio_buffer = bytearray()
                elif msg["text"] == "PING":
                    await ws.send_text("PONG")
                else:
                    try:
                        json_msg = json.loads(msg["text"])
                    except json.JSONDecodeError:
                        print("Invalid JSON message:", msg["text"])
                        continue

                    if "text" in json_msg:
                        text = json_msg["text"]
                        print("Text:", text)
                        for text, audio in agent(text):
                            await ws.send_text(text)
                            if audio is not None:
                                await ws.send_bytes(audio.tobytes())
                            await ws.send_text("EOS")

    except WebSocketDisconnect:
        # client hung up
        pass