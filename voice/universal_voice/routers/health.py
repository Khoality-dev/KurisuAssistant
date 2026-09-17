"""Health, the model listing, and residency on request (#218)."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from universal_voice import config
from universal_voice.models.manager import model_manager
from universal_voice.models.transcriber import transcriber
from universal_voice.scheduler import ModelInUse, scheduler
from universal_voice.tts.registry import tts_registry

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return {"status": "ok"}


def _residency(status: dict, kind: str, model: Any) -> dict:
    """What the scheduler knows about one model, or the idle defaults for one it
    has never seen."""
    entry = status.get(f"{kind}:{model.model_id}")
    if entry is None:
        return {
            "residency": "unloaded",
            "idle_seconds": None,
            "in_use": 0,
            "can_offload": bool(getattr(model, "can_offload", False)),
        }
    return {key: entry[key] for key in ("residency", "idle_seconds", "in_use", "can_offload")}


@router.get("/v1/models")
async def list_models():
    """Every model this instance runs, with its residency (#207): resident,
    offloaded (parked in CPU memory) or unloaded; how long it has been idle;
    whether it is in use right now and whether it can be offloaded (#218)."""
    status = scheduler.status()
    data = []

    if config.ASR_ENABLED:
        cached = model_manager.list_models()
        loaded = transcriber.loaded_models()
        cached_ids = {m["id"] for m in cached} | {m["name"] for m in cached}
        # ASR models — loaded but not in cache list
        for name in loaded:
            if name not in cached_ids:
                data.append({
                    "id": name,
                    "object": "model",
                    "type": "asr",
                    "name": name,
                    "size_mb": None,
                    "loaded": True,
                    **_residency(status, "asr", transcriber.handle(name)),
                })
        # ASR models — cached on disk
        for m in cached:
            data.append({
                "id": m["id"],
                "object": "model",
                "type": "asr",
                "name": m["name"],
                "size_mb": m["size_mb"],
                "loaded": m["id"] in loaded or m["name"] in loaded,
                **_residency(status, "asr", transcriber.handle(m["id"])),
            })

    for m in tts_registry.list_models():
        data.append({**m, **_residency(status, "tts", tts_registry.get_model(m["id"]))})

    return {"object": "list", "data": data}


# --- residency on request (#218) --------------------------------------------

def _resolve(model_id: str) -> tuple[Any, str]:
    """The model behind an id and its kind, or 404: a synthesis model of this
    instance, else a recognition model it has on disk or in memory (by either
    spelling of its name; the handle is keyed by the cache id, #218)."""
    if not model_id:
        # ``{model_id:path}`` matches the empty string too; that is not "the default".
        raise HTTPException(status_code=404, detail="No model named")
    if config.TTS_ENABLED:
        try:
            return tts_registry.get_model(model_id), "tts"
        except ValueError:
            pass
    if config.ASR_ENABLED:
        cached = model_manager.list_models()
        known = {m["id"] for m in cached} | {m["name"] for m in cached} | set(transcriber.loaded_models())
        if model_id in known or model_manager.cache_id(model_id) in known:
            return transcriber.handle(model_id), "asr"
    raise HTTPException(status_code=404, detail=f"No model '{model_id}' in this instance")


def _answer(model: Any, kind: str) -> dict:
    return {"id": model.model_id, "type": kind, **_residency(scheduler.status(), kind, model)}


@router.post("/v1/models/{model_id:path}/load")
async def load_model(model_id: str):
    """Bring the model in and leave it idle; the cap applies as for a request."""
    model, kind = _resolve(model_id)
    try:
        await run_in_threadpool(scheduler.load, model, kind)
    except Exception as e:
        logger.error("load %s failed: %s", model_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    return _answer(model, kind)


@router.post("/v1/models/{model_id:path}/offload")
async def offload_model(model_id: str):
    """Park the model in CPU memory. 409 while it serves a request; a model that
    cannot offload (``can_offload`` false) is left where it is."""
    model, kind = _resolve(model_id)
    try:
        await run_in_threadpool(scheduler.offload, model, kind)
    except ModelInUse as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error("offload %s failed: %s", model_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    return _answer(model, kind)


@router.post("/v1/models/{model_id:path}/unload")
async def unload_model(model_id: str):
    """Drop the model. 409 while it serves a request."""
    model, kind = _resolve(model_id)
    try:
        await run_in_threadpool(scheduler.unload, model, kind)
    except ModelInUse as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error("unload %s failed: %s", model_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    return _answer(model, kind)


# --- the Whisper cache -------------------------------------------------------

def _require_asr() -> None:
    if not config.ASR_ENABLED:
        raise HTTPException(
            status_code=404,
            detail=f"Recognition is not an engine of this instance (UVOICE_ENGINES={','.join(sorted(config.ENGINES))})",
        )


@router.post("/v1/models/pull")
async def pull_model(body: dict):
    """Download and convert a model. Body: {"model": "vinai/PhoWhisper-base"}"""
    _require_asr()
    model_name = body.get("model")
    if not model_name:
        raise HTTPException(status_code=400, detail="'model' field required")

    try:
        path = await run_in_threadpool(model_manager.resolve_model, model_name)
        return {"status": "ok", "model": model_name, "path": path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/v1/models/{model_name:path}")
async def delete_model(model_name: str):
    """Unload and delete a cached model. 409 while it serves a request.

    The unload goes through the scheduler, so its entry agrees with memory: a
    direct unload used to leave the entry ``resident``, and the next ``load``
    then trusted that and loaded nothing (#218).
    """
    _require_asr()
    try:
        await run_in_threadpool(scheduler.unload, transcriber.handle(model_name), "asr")
    except ModelInUse as e:
        raise HTTPException(status_code=409, detail=str(e))
    if model_manager.delete_model(model_name):
        return {"status": "deleted", "model": model_name}
    raise HTTPException(status_code=404, detail=f"Model '{model_name}' not found")
