"""ASR routes: /asr — proxies to universal-voice service."""

import logging
import os

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.errors import internal_error
from kurisuassistant.core.http import get_client

logger = logging.getLogger(__name__)

router = APIRouter(tags=["asr"])

ASR_API_URL = os.environ.get("ASR_API_URL", "http://universal-voice:14213").rstrip("/")


@router.post("/asr")
async def asr_endpoint(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    language: str | None = Query(None),
    model: str | None = Query(None),
    initial_prompt: str | None = Query(None),
    _user=Depends(get_authenticated_user),
):
    """Proxy raw PCM audio to universal-voice service."""
    try:
        params: dict = {}
        if language:
            params["language"] = language
        if model:
            params["model"] = model
        if initial_prompt:
            params["initial_prompt"] = initial_prompt

        r = await get_client().post(
            f"{ASR_API_URL}/asr",
            content=audio,
            params=params,
            headers={"Content-Type": "application/octet-stream"},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise internal_error(
            e, "ASR service request failed", status_code=502,
            public_detail="The speech service is unavailable.",
        )


@router.post("/asr/detect-language")
async def asr_detect_language(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    model: str | None = Query(None),
    _user=Depends(get_authenticated_user),
):
    """Detect the spoken language of an audio clip."""
    try:
        params: dict = {}
        if model:
            params["model"] = model

        r = await get_client().post(
            f"{ASR_API_URL}/asr/detect-language",
            content=audio,
            params=params,
            headers={"Content-Type": "application/octet-stream"},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise internal_error(
            e, "ASR detect-language request failed", status_code=502,
            public_detail="The speech service is unavailable.",
        )


@router.get("/asr/models")
async def asr_models(_user=Depends(get_authenticated_user)):
    """List ASR models available on the universal-voice service."""
    try:
        r = await get_client().get(f"{ASR_API_URL}/v1/models", timeout=10)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise internal_error(
            e, "ASR models request failed", status_code=502,
            public_detail="The speech service is unavailable.",
        )
