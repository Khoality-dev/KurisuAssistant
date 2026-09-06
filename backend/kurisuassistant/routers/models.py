"""Model management routes: list, pull, delete models."""

import asyncio
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from kurisuassistant.core.errors import internal_error, log_internal_error
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.models import User
from kurisuassistant.models.llm import list_models as llm_list_models, pull_model as llm_pull_model, create_llm_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/models", tags=["models"])


class ModelInfo(BaseModel):
    """Model information."""
    name: str
    size: int  # Size in bytes
    modified_at: str


class PullModelRequest(BaseModel):
    """Request to pull a model."""
    name: str


class PullModelResponse(BaseModel):
    """Response after pulling a model."""
    status: str
    message: str


# Providers whose models are listed when the user has stored a key for them.
_KEYED_PROVIDERS = (
    ("gemini", "gemini_api_key", "Google Gemini"),
    ("nvidia", "nvidia_api_key", "NVIDIA NIM"),
    ("poe", "poe_api_key", "Poe"),
)


def _unreachable(provider: str, label: str, exc: Exception) -> dict:
    """One entry of the ``unavailable`` list, logged in full with a reference."""
    reference = log_internal_error(exc, f"listing {label} models")
    if provider == "ollama":
        detail = ("The Ollama server is unreachable. Check the server's LLM_API_URL, "
                  "or the Ollama URL in your account settings.")
    else:
        detail = f"{label} could not be reached with the stored key."
    return {"provider": provider, "detail": f"{detail} (reference: {reference})"}


@router.get("")
async def list_models(
    user: User = Depends(get_authenticated_user),
) -> dict:
    """List available LLM models across the providers the user can use.

    A provider that cannot be reached is reported in ``unavailable`` rather
    than silently contributing nothing, and when *no* provider answered the
    response is a 502 — an empty picker used to be the only symptom of a wrong
    ``LLM_API_URL``, and it reads as "no models installed" (#151).
    """
    models: list = []
    unavailable: list = []

    try:
        ollama_models = await asyncio.to_thread(llm_list_models, api_url=user.ollama_url)
        models.extend({"name": m, "provider": "ollama"} for m in ollama_models)
    except Exception as e:
        unavailable.append(_unreachable("ollama", "Ollama", e))

    for provider, key_attr, label in _KEYED_PROVIDERS:
        api_key = getattr(user, key_attr, None)
        if not api_key:
            continue
        try:
            llm_provider = create_llm_provider(provider, api_key=api_key)
            names = await asyncio.to_thread(llm_provider.list_models)
            models.extend({"name": m, "provider": provider} for m in names)
        except Exception as e:
            unavailable.append(_unreachable(provider, label, e))

    if not models and unavailable:
        raise HTTPException(
            status_code=502,
            detail=" ".join(entry["detail"] for entry in unavailable),
        )
    return {"models": models, "unavailable": unavailable}


@router.get("/details")
async def list_models_detailed(
    user: User = Depends(get_authenticated_user),
) -> dict:
    """List available models with detailed info (size, modified date)."""
    try:
        user_ollama_url = user.ollama_url
        provider = create_llm_provider("ollama", api_url=user_ollama_url)

        # Get detailed model list from Ollama
        resp = await asyncio.to_thread(provider.client.list)
        models = []
        for m in getattr(resp, "models", []):
            models.append(ModelInfo(
                name=m.model,
                size=getattr(m, "size", 0),
                modified_at=str(getattr(m, "modified_at", "")),
            ))

        return {"models": models}
    except Exception as e:
        raise internal_error(e, "Error fetching model details")


@router.post("/pull")
async def pull_model(
    body: PullModelRequest,
    user: User = Depends(get_authenticated_user),
) -> PullModelResponse:
    """Pull/download a model from Ollama registry."""
    try:
        user_ollama_url = user.ollama_url
        await asyncio.to_thread(llm_pull_model, body.name, api_url=user_ollama_url)
        return PullModelResponse(
            status="ok",
            message=f"Model '{body.name}' pulled successfully"
        )
    except Exception as e:
        raise internal_error(e, f"Error pulling model '{body.name}'")


@router.delete("/{model_name:path}")
async def delete_model(
    model_name: str,
    user: User = Depends(get_authenticated_user),
) -> dict:
    """Delete a downloaded model."""
    try:
        user_ollama_url = user.ollama_url
        provider = create_llm_provider("ollama", api_url=user_ollama_url)
        await asyncio.to_thread(provider.client.delete, model_name)
        return {"status": "ok", "message": f"Model '{model_name}' deleted successfully"}
    except Exception as e:
        raise internal_error(e, f"Error deleting model '{model_name}'")


@router.post("/ensure/{model_name:path}")
async def ensure_model(
    model_name: str,
    user: User = Depends(get_authenticated_user),
) -> dict:
    """Ensure a model is available, pulling it if necessary."""
    try:
        user_ollama_url = user.ollama_url
        models = await asyncio.to_thread(llm_list_models, api_url=user_ollama_url)

        # Check if model already exists
        if model_name in models:
            return {"status": "ok", "message": f"Model '{model_name}' already available"}

        # Pull the model
        await asyncio.to_thread(llm_pull_model, model_name, api_url=user_ollama_url)
        return {"status": "ok", "message": f"Model '{model_name}' pulled successfully"}
    except Exception as e:
        raise internal_error(e, f"Error ensuring model '{model_name}'")


class ValidateKeyRequest(BaseModel):
    provider: str  # "gemini", "nvidia" or "poe"
    api_key: str


@router.post("/validate-key")
async def validate_api_key(
    body: ValidateKeyRequest,
    user: User = Depends(get_authenticated_user),
) -> dict:
    """Validate an API key with its provider and report how many models it unlocks.

    Each provider decides what validation means (``BaseLLMProvider.validate_key``):
    listing models where that needs the key, an authenticated probe where the
    catalogue is public and listing would accept any key.
    """
    try:
        provider = create_llm_provider(body.provider, api_key=body.api_key)
        model_count = await asyncio.to_thread(provider.validate_key)
        return {"valid": True, "model_count": model_count}
    except Exception as e:
        return {"valid": False, "error": str(e)}
