"""Model management routes: list, pull, delete models."""

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import UserRepository
from models.llm import list_models as llm_list_models, pull_model as llm_pull_model, create_llm_provider

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
    db: Session = Depends(get_db),
) -> dict:
    """List available LLM models."""
    try:
        user_ollama_url = user.ollama_url
        models = llm_list_models(api_url=user_ollama_url)
        return {"models": models}
    except Exception as e:
        logger.error(f"Error fetching models: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/details")
async def list_models_detailed(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> dict:
    """List available models with detailed info (size, modified date)."""
    try:
        user_ollama_url = user.ollama_url
        provider = create_llm_provider("ollama", api_url=user_ollama_url)

        # Get detailed model list from Ollama
        resp = provider.client.list()
        models = []
        for m in getattr(resp, "models", []):
            models.append(ModelInfo(
                name=m.model,
                size=getattr(m, "size", 0),
                modified_at=str(getattr(m, "modified_at", "")),
            ))

        return {"models": models}
    except Exception as e:
        logger.error(f"Error fetching model details: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/pull")
async def pull_model(
    body: PullModelRequest,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PullModelResponse:
    """Pull/download a model from Ollama registry."""
    try:
        user_ollama_url = user.ollama_url
        llm_pull_model(body.name, api_url=user_ollama_url)
        return PullModelResponse(
            status="ok",
            message=f"Model '{body.name}' pulled successfully"
        )
    except Exception as e:
        logger.error(f"Error pulling model '{body.name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{model_name:path}")
async def delete_model(
    model_name: str,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> dict:
    """Delete a downloaded model."""
    try:
        user_ollama_url = user.ollama_url
        provider = create_llm_provider("ollama", api_url=user_ollama_url)
        provider.client.delete(model_name)
        return {"status": "ok", "message": f"Model '{model_name}' deleted successfully"}
    except Exception as e:
        logger.error(f"Error deleting model '{model_name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ensure/{model_name:path}")
async def ensure_model(
    model_name: str,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> dict:
    """Ensure a model is available, pulling it if necessary."""
    try:
        user_ollama_url = user.ollama_url
        models = llm_list_models(api_url=user_ollama_url)

        # Check if model already exists
        if model_name in models:
            return {"status": "ok", "message": f"Model '{model_name}' already available"}

        # Pull the model
        llm_pull_model(model_name, api_url=user_ollama_url)
        return {"status": "ok", "message": f"Model '{model_name}' pulled successfully"}
    except Exception as e:
        logger.error(f"Error ensuring model '{model_name}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
