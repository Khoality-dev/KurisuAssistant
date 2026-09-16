"""FastAPI application for Universal Voice."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from universal_voice import config
from universal_voice.models.manager import model_manager
from universal_voice.routers import health, transcription, tts

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Pre-load default models on startup."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    if config.DEFAULT_MODEL:
        logger.info("Pre-loading default ASR model: %s", config.DEFAULT_MODEL)
        try:
            model_manager.resolve_model(config.DEFAULT_MODEL)
            logger.info("Default ASR model ready: %s", config.DEFAULT_MODEL)
        except Exception:
            logger.exception("Failed to pre-load default ASR model")

    logger.info("Initializing TTS registry...")
    try:
        from universal_voice.tts.registry import tts_registry
        # Pre-load VieNeu model (runs in-process)
        vieneu = tts_registry.get_model(f"vieneu:{config.TTS_MODE}")
        vieneu.get_engine()
        logger.info("VieNeu TTS ready (%s)", vieneu.model_id)
    except Exception:
        logger.exception("Failed to pre-load VieNeu TTS")

    yield


app = FastAPI(title="Universal Voice", lifespan=lifespan)

app.include_router(health.router)
app.include_router(transcription.router)
app.include_router(tts.router)


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def main():
    import uvicorn
    uvicorn.run(
        "universal_voice.main:app",
        host=config.HOST,
        port=config.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
