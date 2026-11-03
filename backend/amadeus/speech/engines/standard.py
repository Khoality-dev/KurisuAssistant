"""Any engine that speaks the contract — which is every synthesis engine.

``docs/speech-engine-contract.md`` is the contract; this is the one adapter
for it (#227). An engine is a name the clients store as a model id and an
address, and that is all the backend knows about it. What used to be one
module per dialect is this file.
"""

import logging

from fastapi import HTTPException

from .base import Engine
from .reference import VoiceReference

logger = logging.getLogger(__name__)


class CannotLoad(HTTPException):
    """The engine answered 503: its model could not be loaded.

    The memory-pressure signal of the contract. The engine is the one that
    knows the card is full; the backend's answer is to release another engine
    and try once more (``synthesis.py``).
    """

    def __init__(self, engine: "StandardEngine", reason: str):
        super().__init__(status_code=503, detail=reason)
        self.engine = engine


class StandardEngine(Engine):
    kind = "tts"

    def __init__(self, model_id: str, url: str):
        super().__init__(url)
        self.model_id = model_id

    async def synthesize(
        self,
        text: str,
        *,
        reference: VoiceReference | None = None,
        voice_id: str | None = None,
        language: str | None = None,
        timeout: float = 120,
    ) -> bytes:
        """One chunk of ``text`` as WAV bytes. A 503 is ``CannotLoad``."""
        data: dict[str, str] = {"text": text}
        if language:
            data["language"] = language
        if voice_id:
            data["voice_id"] = voice_id
        files = None
        if reference is not None:
            files = {"ref_audio": (reference.filename, reference.read())}
            if reference.transcript:
                data["ref_text"] = reference.transcript
        try:
            response = await self.call(
                "POST", "/synthesize", context="TTS synthesis", data=data, files=files, timeout=timeout,
            )
        except HTTPException as e:
            if e.status_code == 503:
                raise CannotLoad(self, e.detail) from e
            raise
        return response.content

    async def voices(self) -> list[dict]:
        """The engine's presets. An engine that cannot be asked contributes
        none: a listing is not the place to surface an outage."""
        response = await self.quietly("GET", "/voices", timeout=10)
        if response is None or response.status_code >= 400:
            return []
        try:
            body = response.json()
        except ValueError:
            return []
        return [v for v in body if isinstance(v, dict) and "id" in v] if isinstance(body, list) else []

    async def release(self) -> str:
        """Ask the engine to drop its weights.

        ``"released"``, ``"busy"`` (409: a synthesis is in flight, the engine's
        call), or ``"unreachable"``. Never raises: releasing is best effort and
        the request that asked for it has its own answer to give.
        """
        response = await self.quietly("POST", "/release", timeout=30)
        if response is None:
            return "unreachable"
        if response.status_code == 409:
            logger.info("TTS release: %s is busy", self.model_id)
            return "busy"
        if response.status_code >= 400:
            logger.warning("TTS release: %s answered %s", self.model_id, response.status_code)
            return "unreachable"
        logger.info("TTS release: %s released", self.model_id)
        return "released"
