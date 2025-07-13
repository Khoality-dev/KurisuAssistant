from fastapi import FastAPI, Body, HTTPException, Response
from helpers.tts import TTS

app = FastAPI(
    title="Kurisu TTS Hub API",
    description="REST API for Kurisu Assistant TTS hub",
    version="0.1.0",
)

tts_model = TTS()

@app.post(
    "/tts",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
async def tts(text: str = Body(..., embed=True)):
    result = tts_model(text)
    if result is None:
        raise HTTPException(status_code=500, detail="TTS Error")
    return Response(content=result, media_type="application/octet-stream")
