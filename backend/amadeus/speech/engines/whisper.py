"""Recognition, as a Whisper ASR webservice speaks it.

The image is ``onerahmet/openai-whisper-asr-webservice``, which serves one
model per container (``ASR_MODEL``) and unloads it after ``MODEL_IDLE_TIMEOUT``,
as every engine now manages its own memory. Recognition is not part of the
synthesis contract (``docs/speech-engine-contract.md``); this is its own
dialect. Audio goes over as a WAV upload; the clients send raw PCM, which
``speech/text.py`` wraps.

``POST /detect-language`` takes no list of candidates, so the ``languages``
constraint a client sends is applied here instead: the engine's answer is kept
when it is one of them, and otherwise reported with its confidence so the
client falls back to its default model, which is what it already does for a
language it has no mapping for.
"""

import os

from .base import Engine


class Whisper(Engine):
    kind = "asr"
    # The webservice has no /health; its OpenAPI document is served by the same
    # app and proves the process is up without loading anything.
    health_path = "/openapi.json"

    def __init__(self, url: str, model_id: str | None = None):
        super().__init__(url)
        # What the container was started with; the clients store this string.
        self.model_id = model_id or os.environ.get("ASR_MODEL", "base")

    async def transcribe(
        self,
        wav: bytes,
        *,
        language: str | None = None,
        initial_prompt: str | None = None,
        timeout: float = 60,
    ) -> dict:
        params: dict[str, str] = {"task": "transcribe", "output": "json"}
        if language:
            params["language"] = language
        if initial_prompt:
            params["initial_prompt"] = initial_prompt
        response = await self.call(
            "POST", "/asr", context="ASR",
            params=params, files={"audio_file": ("audio.wav", wav, "audio/wav")}, timeout=timeout,
        )
        body = response.json()
        return {
            "text": (body.get("text") or "").strip(),
            "language": language or body.get("language") or "",
        }

    async def detect_language(self, wav: bytes, *, timeout: float = 30) -> dict:
        response = await self.call(
            "POST", "/detect-language", context="ASR detect-language",
            files={"audio_file": ("audio.wav", wav, "audio/wav")}, timeout=timeout,
        )
        body = response.json()
        return {
            "language": body.get("language_code") or body.get("detected_language") or "",
            "confidence": round(float(body.get("confidence") or 0.0), 4),
        }
