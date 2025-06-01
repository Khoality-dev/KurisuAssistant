import asyncio
import datetime
import json
import os
import re
import subprocess
import wave
from helpers.tools import get_notification
from fastapi import FastAPI, Request, HTTPException, Response, Body, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from transformers import pipeline
from helpers.tts import TTS
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
asr_model = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda' if torch.cuda.is_available() else 'cpu',
)
tts_model = TTS()
SAMPLE_RATE = 16_000         # Hz
SAMPLE_WIDTH = 2             # bytes per sample (16-bit)

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    # Authenticate
    try:
        data = await asyncio.wait_for(ws.receive(), timeout=5.0)
        if data.get("text") is not None:
            bearer_token = data["text"]
            local_token = os.getenv("AUTHENTICATION_TOKEN", "")
            if bearer_token != local_token:
                print("Invalid token")
                await ws.close()
                return
            print("Authenticated")
    except:
        print("Failed to authenticate")
        await ws.close()
        return
    
    llm_model = LLM()
    try:
        while True:
            data = await ws.receive()
            if data.get("text") is not None:
                text_payload = data["text"]
                json_body = json.loads(text_payload)
                response_generator = llm_model(json_body)
                for response in response_generator:
                    audio_data = tts_model(response["message"]["content"])
                    await ws.send_text(json.dumps(response))
                    if audio_data is None:
                        audio_data = b''
                    await ws.send_bytes(audio_data)

            elif data.get("bytes") is not None:
                audio_data = data["bytes"]
                pcm = np.frombuffer(audio_data, dtype=np.int16)
                waveform = pcm.astype(np.float32) / 32768.0

                # 2) Run your ASR model
                result = asr_model(waveform)   # assuming `asr` is your pipeline
                text_payload = result["text"]
                print("ASR Result: ", text_payload)
                json_body = {
                    "text": text_payload
                }
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
