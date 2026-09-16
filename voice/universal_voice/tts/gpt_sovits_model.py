"""GPT-SoVITS TTS model — HTTP client to GPT-SoVITS container."""

import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Optional

import requests

from universal_voice import config
from .base import BaseTTSModel
from .text_processing import split_text, merge_wav_files

logger = logging.getLogger(__name__)


class GPTSoVITSModel(BaseTTSModel):
    """GPT-SoVITS model. Calls the GPT-SoVITS Docker container API.

    Requires a voice reference for synthesis. Reference audio is received
    as bytes, written to a shared temp volume, and passed as a file path
    to the GPT-SoVITS API.
    """

    @property
    def model_id(self) -> str:
        return "gpt-sovits"

    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
        ref_audio_bytes: Optional[bytes] = None,
        ref_text: Optional[str] = None,
        **kwargs,
    ) -> bytes:
        if not ref_audio_bytes:
            raise RuntimeError(
                "GPT-SoVITS requires a voice reference for synthesis. "
                "Pass ref_audio with the request."
            )

        # Write ref audio to shared volume so GPT-SoVITS container can read it
        ref_filename = f"{uuid.uuid4().hex}.wav"
        local_path = Path(config.GPTSOVITS_REF_AUDIO_DIR) / ref_filename
        container_path = f"{config.GPTSOVITS_REF_AUDIO_PREFIX}/{ref_filename}"

        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(ref_audio_bytes)

        try:
            return self._synthesize_with_ref(text, container_path, language, **kwargs)
        finally:
            local_path.unlink(missing_ok=True)

    def _synthesize_with_ref(
        self,
        text: str,
        ref_audio_path: str,
        language: Optional[str],
        **kwargs,
    ) -> bytes:
        text_lang = language or "ja"
        prompt_lang = language or "ja"
        max_chunk_length = kwargs.get("max_chunk_length", 200)
        endpoint = f"{config.GPTSOVITS_URL}/tts"

        text_chunks = split_text(text, max_length=max_chunk_length)
        logger.debug("Split text into %d chunks for GPT-SoVITS synthesis", len(text_chunks))

        audio_chunks = []
        for i, chunk in enumerate(text_chunks):
            params = {
                "text": chunk,
                "text_lang": text_lang,
                "ref_audio_path": ref_audio_path,
                "prompt_lang": prompt_lang,
                "text_split_method": kwargs.get("text_split_method", "cut5"),
                "batch_size": kwargs.get("batch_size", 20),
                "media_type": "wav",
                "streaming_mode": False,
            }

            try:
                response = requests.get(endpoint, params=params, timeout=60)
                response.raise_for_status()
                audio_chunks.append(response.content)
            except requests.exceptions.RequestException as e:
                logger.error("GPT-SoVITS request failed for chunk %d: %s", i + 1, e, exc_info=True)
                raise RuntimeError(f"GPT-SoVITS synthesis failed for chunk {i + 1}: {e}") from e

        return merge_wav_files(audio_chunks)

    def list_voices(self) -> list[dict]:
        # GPT-SoVITS has no built-in preset voices
        return []

    def check_health(self) -> dict:
        url = f"{config.GPTSOVITS_URL}/tts"
        try:
            requests.get(url, params={"text": "", "text_lang": "ja"}, timeout=5)
            return {"ok": True, "message": f"Connected to {config.GPTSOVITS_URL}"}
        except requests.exceptions.ConnectionError:
            return {"ok": False, "message": f"Cannot connect to {config.GPTSOVITS_URL}"}
        except requests.exceptions.Timeout:
            return {"ok": False, "message": f"Timeout: {config.GPTSOVITS_URL}"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    def is_loaded(self) -> Optional[bool]:
        return None  # Remote service, unknown
