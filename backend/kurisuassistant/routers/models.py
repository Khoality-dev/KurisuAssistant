"""Model management routes: list, pull, delete models."""

import asyncio
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from kurisuassistant.core.errors import internal_error
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


@router.get("")
async def list_models(
    user: User = Depends(get_authenticated_user),
) -> dict:
    """List available LLM models."""
    try:
        user_ollama_url = user.ollama_url
        ollama_models = await asyncio.to_thread(llm_list_models, api_url=user_ollama_url)

        # Build model list: [{name, provider}]
        models = [{"name": m, "provider": "ollama"} for m in ollama_models]

        # Add Gemini models if user has API key
        gemini_api_key = getattr(user, 'gemini_api_key', None)
        if gemini_api_key:
            try:
                gemini_provider = create_llm_provider("gemini", api_key=gemini_api_key)
                gemini_models = await asyncio.to_thread(gemini_provider.list_models)
                models.extend({"name": m, "provider": "gemini"} for m in gemini_models)
            except Exception as ge:
                logger.warning(f"Failed to list Gemini models: {ge}")

        # Add NVIDIA NIM models if user has API key
        nvidia_api_key = getattr(user, 'nvidia_api_key', None)
        if nvidia_api_key:
            try:
                nvidia_provider = create_llm_provider("nvidia", api_key=nvidia_api_key)
                nvidia_models = await asyncio.to_thread(nvidia_provider.list_models)
                models.extend({"name": m, "provider": "nvidia"} for m in nvidia_models)
            except Exception as ne:
                logger.warning(f"Failed to list NVIDIA models: {ne}")

        # Add Poe models if user has API key
        poe_api_key = getattr(user, 'poe_api_key', None)
        if poe_api_key:
            try:
                poe_provider = create_llm_provider("poe", api_key=poe_api_key)
                poe_models = await asyncio.to_thread(poe_provider.list_models)
                models.extend({"name": m, "provider": "poe"} for m in poe_models)
            except Exception as pe:
                logger.warning(f"Failed to list Poe models: {pe}")

        return {"models": models}
    except Exception as e:
        raise internal_error(e, "Error fetching models")


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
