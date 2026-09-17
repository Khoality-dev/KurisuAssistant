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
    """Start the preloads and the sweeper; serve meanwhile."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger.info("Engines in this instance: %s", ", ".join(sorted(config.ENGINES)))
    # Everything that pulls or loads runs on a thread: the first pull is
    # gigabytes and the loads are tens of seconds, and /health must answer
    # meanwhile (#218 — the ASR pull used to run inline here, so the process
    # accepted nothing until it was done). A model not yet loaded is reported
    # as such by /v1/models, and a request for it waits on its lock.
    threading.Thread(target=_preload, name="preload", daemon=True).start()
    # Parks idle models in CPU memory and drops them after longer (#207).
    threading.Thread(target=scheduler.run_forever, name="residency-sweeper", daemon=True).start()

    yield


def _preload() -> None:
    # A thread's uncaught exception is a line on stderr and nothing else, so
    # nothing here may escape unlogged.
    try:
        _preload_models()
    except Exception:
        logger.exception("Preload failed")


def _preload_models() -> None:
    if config.ASR_ENABLED and config.DEFAULT_MODEL:
        # On disk, converted, ready to load on the first request — not loaded.
        logger.info("Pre-fetching default ASR model: %s", config.DEFAULT_MODEL)
        try:
            model_manager.resolve_model(config.DEFAULT_MODEL)
            logger.info("Default ASR model ready: %s", config.DEFAULT_MODEL)
        except Exception:
            logger.exception("Failed to pre-fetch default ASR model")

    from universal_voice.tts.registry import tts_registry

    registered = [m["id"] for m in tts_registry.list_models()]
    # An engine name (``vieneu``) stands for its model id (``vieneu:turbo``).
    by_engine = {model_id.split(":")[0]: model_id for model_id in registered}
    if config.TTS_PRELOAD_EXPLICIT:
        wanted = config.TTS_PRELOAD
    else:
        # Unset: the instance's own default, which an engine-only instance
        # resolves to the one model it runs.
        wanted = [tts_registry.default_model_id()] if registered else []
    for name in wanted:
        model_id = name if name in registered else by_engine.get(name)
        if model_id is None:
            logger.info("TTS preload: %s is not a model of this instance (%s); skipped", name, ", ".join(registered))
            continue
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
