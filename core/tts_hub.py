from fastapi import FastAPI, Body, HTTPException, Response, Depends
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from helpers.tts import TTS
from auth import authenticate_user, create_access_token, get_current_user

app = FastAPI(
    title="Kurisu TTS Hub API",
    description="REST API for Kurisu Assistant TTS hub",
    version="0.1.0",
)

tts_model = TTS()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")


@app.post("/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    if authenticate_user(form_data.username, form_data.password):
        token = create_access_token({"sub": form_data.username})
        return {"access_token": token, "token_type": "bearer"}
    raise HTTPException(status_code=400, detail="Incorrect username or password")

@app.post(
    "/tts",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
async def tts(
    text: str = Body(..., embed=True),
    token: str = Depends(oauth2_scheme),
):
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    result = tts_model(text)
    if result is None:
        raise HTTPException(status_code=500, detail="TTS Error")
    return Response(content=result, media_type="application/octet-stream")
