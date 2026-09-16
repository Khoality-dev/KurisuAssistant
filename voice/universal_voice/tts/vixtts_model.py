"""viXTTS model — HTTP client to viXTTS container."""

import io
import logging
from typing import Optional

import requests

from universal_voice import config
from .base import BaseTTSModel
from .text_processing import split_text, merge_wav_files

logger = logging.getLogger(__name__)


class ViXTTSModel(BaseTTSModel):
    """viXTTS model. Calls the viXTTS Docker container API.

    Supports optional voice reference (uploaded as multipart) and
    emotion audio parameters.
    """

    @property
    def model_id(self) -> str:
        return "vixtts"

    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
        ref_audio_bytes: Optional[bytes] = None,
        ref_text: Optional[str] = None,
        **kwargs,
    ) -> bytes:
        max_chunk_length = kwargs.get("max_chunk_length", 200)
        endpoint = f"{config.VIXTTS_URL}/tts/file"

        text_chunks = split_text(text, max_length=max_chunk_length)
        logger.debug("Split text into %d chunks for viXTTS synthesis", len(text_chunks))

        audio_chunks = []
        for i, chunk in enumerate(text_chunks):
            data = {
                "text": chunk,
                "emo_alpha": kwargs.get("emo_alpha", 1.0),
                "use_emo_text": kwargs.get("use_emo_text", False),
                "use_random": kwargs.get("use_random", False),
            }
            if language:
                data["language"] = language
            if "emo_text" in kwargs:
                data["emo_text"] = kwargs["emo_text"]

            files = {}
            try:
                if ref_audio_bytes:
                    files["spk_audio"] = ("ref.wav", io.BytesIO(ref_audio_bytes), "audio/wav")

                response = requests.post(endpoint, files=files or None, data=data, timeout=120)
                response.raise_for_status()
                audio_chunks.append(response.content)
            except requests.exceptions.RequestException as e:
                logger.error("viXTTS request failed for chunk %d: %s", i + 1, e, exc_info=True)
                raise RuntimeError(f"viXTTS synthesis failed for chunk {i + 1}: {e}") from e

        return merge_wav_files(audio_chunks)

    def list_voices(self) -> list[dict]:
        # viXTTS has no built-in preset voices
        return []

    def check_health(self) -> dict:
        url = f"{config.VIXTTS_URL}/health"
        try:
            response = requests.get(url, timeout=5)
            return {"ok": True, "message": f"Connected to {config.VIXTTS_URL}"}
        except requests.exceptions.ConnectionError:
            return {"ok": False, "message": f"Cannot connect to {config.VIXTTS_URL}"}
        except requests.exceptions.Timeout:
            return {"ok": False, "message": f"Timeout: {config.VIXTTS_URL}"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    def is_loaded(self) -> Optional[bool]:
        return None  # Remote service, unknown
