"""FastAPI application for Universal Voice."""

import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from universal_voice import config
from universal_voice.models.manager import model_manager
from universal_voice.scheduler import scheduler
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

    # Every synthesis backend runs in this process (#203). The ones in
    # TTS_PRELOAD load now, on a thread: the first pull is gigabytes and the
    # loads are tens of seconds, and /health should answer meanwhile — a model
    # not yet loaded is reported as such by /v1/models, and a request for it
    # waits on its lock rather than failing.
    threading.Thread(target=_preload_tts, name="tts-preload", daemon=True).start()
    # Parks idle models in CPU memory and drops them after longer (#207).
    threading.Thread(target=scheduler.run_forever, name="residency-sweeper", daemon=True).start()

    yield


def _preload_tts() -> None:
    from universal_voice.tts.registry import tts_registry

    for model_id in config.TTS_PRELOAD:
        try:
            model = tts_registry.get_model(model_id)
            scheduler.preload(model)
            logger.info("TTS ready: %s", model.model_id)
        except Exception:
            logger.exception("Failed to pre-load TTS model %s", model_id)


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
