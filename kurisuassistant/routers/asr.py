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
    mode: str | None = Query(None),
    _user=Depends(get_authenticated_user),
):
    """Proxy raw PCM audio to universal-asr service."""
    try:
        params = {}
        if language:
            params["language"] = language
        if mode:
            params["mode"] = mode

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
