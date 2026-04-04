"""ASR routes: /asr — proxies to universal-asr service."""

import logging
import os

import requests as http_requests
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from kurisuassistant.core.deps import get_authenticated_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["asr"])

ASR_API_URL = os.environ.get("ASR_API_URL", "http://universal-asr:14213").rstrip("/")


@router.post("/asr")
async def asr_endpoint(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    language: str | None = Query(None),
    model: str | None = Query(None),
    initial_prompt: str | None = Query(None),
    _user=Depends(get_authenticated_user),
):
    """Proxy raw PCM audio to universal-asr service."""
    try:
        params: dict = {}
        if language:
            params["language"] = language
        if model:
            params["model"] = model
        if initial_prompt:
            params["initial_prompt"] = initial_prompt

        r = http_requests.post(
            f"{ASR_API_URL}/asr",
            data=audio,
            params=params,
            headers={"Content-Type": "application/octet-stream"},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()
    except http_requests.RequestException as e:
        logger.error("ASR service error: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"ASR service error: {e}")


@router.post("/asr/detect-language")
async def asr_detect_language(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    languages: str | None = Query(None),
    _user=Depends(get_authenticated_user),
):
    """Detect language from raw PCM audio. Optional: constrain to comma-separated codes."""
    try:
        params: dict = {}
        if languages:
            params["languages"] = languages

        r = http_requests.post(
            f"{ASR_API_URL}/asr/detect-language",
            data=audio,
            params=params,
            headers={"Content-Type": "application/octet-stream"},
            timeout=15,
        )
        r.raise_for_status()
        return r.json()
    except http_requests.RequestException as e:
        logger.error("ASR detect-language error: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"ASR service error: {e}")


@router.get("/asr/models")
async def asr_models(_user=Depends(get_authenticated_user)):
    """Proxy model list from universal-asr service."""
    try:
        r = http_requests.get(f"{ASR_API_URL}/v1/models", timeout=10)
        r.raise_for_status()
        return r.json()
    except http_requests.RequestException as e:
        logger.error("ASR models error: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"ASR service error: {e}")
