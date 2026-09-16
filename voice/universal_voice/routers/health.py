"""Health and model listing endpoints."""

from fastapi import APIRouter, HTTPException

from universal_voice.models.manager import model_manager
from universal_voice.models.transcriber import transcriber
from universal_voice.tts.registry import tts_registry

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/v1/models")
async def list_models():
    """List all models (ASR + TTS)."""
    cached = model_manager.list_models()
    loaded = transcriber.loaded_models()
    cached_ids = {m["id"] for m in cached} | {m["name"] for m in cached}

    data = []
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
        })

    # TTS models
    data.extend(tts_registry.list_models())

    return {"object": "list", "data": data}


@router.post("/v1/models/pull")
async def pull_model(body: dict):
    """Download and convert a model. Body: {"model": "vinai/PhoWhisper-base"}"""
    model_name = body.get("model")
    if not model_name:
        raise HTTPException(status_code=400, detail="'model' field required")

    try:
        path = model_manager.resolve_model(model_name)
        return {"status": "ok", "model": model_name, "path": path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/v1/models/{model_name:path}")
async def delete_model(model_name: str):
    """Delete a cached model."""
    transcriber.unload_model(model_name)
    if model_manager.delete_model(model_name):
        return {"status": "deleted", "model": model_name}
    raise HTTPException(status_code=404, detail=f"Model '{model_name}' not found")
