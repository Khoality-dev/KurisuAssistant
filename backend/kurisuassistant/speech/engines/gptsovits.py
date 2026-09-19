"""GPT-SoVITS, as its api_v2 server speaks it.

The image is ``legwork7623/gpt-sovits``, published from the owner's fork with
``api_v2.py`` as its command. Synthesis is a GET with the parameters in the
query, and the reference clip is named by a **path the engine opens itself** —
so the clip has to be on a filesystem both containers see. The stack mounts
``data/voice_storage/`` into the engine read-only and ``GPTSOVITS_VOICE_DIR``
is where the engine sees it; nothing is copied and no scratch volume is shared.
"""

import logging
import os

import httpx

from kurisuassistant.core.http import get_client

from .base import Engine
from .reference import VoiceReference

#: TTS_Config.v2_languages, as upstream names them.
LANGUAGES = ("auto", "auto_yue", "en", "zh", "ja", "yue", "ko", "all_zh", "all_ja", "all_yue", "all_ko")
ALIASES = {"zh-cn": "zh", "jp": "ja", "en-us": "en", "en-gb": "en"}

logger = logging.getLogger(__name__)


class GPTSoVITS(Engine):
    model_id = "gpt-sovits"
    kind = "tts"

    def __init__(self, url: str):
        super().__init__(url)
        self.voice_dir = os.environ.get("GPTSOVITS_VOICE_DIR", "/voice_storage").rstrip("/")
        self.default_language = os.environ.get("GPTSOVITS_DEFAULT_LANGUAGE", "ja")

    def language(self, language: str | None) -> str:
        lang = (language or self.default_language).strip().lower()
        return ALIASES.get(lang, lang)

    async def synthesize(
        self,
        text: str,
        *,
        reference: VoiceReference | None = None,
        voice_id: str | None = None,
        language: str | None = None,
        timeout: float = 120,
    ) -> bytes:
        """One chunk of ``text`` as WAV bytes.

        A reference clip is required — this engine clones and has no preset
        voices, so a request without one is the caller's mistake and reads as
        such rather than as an outage.
        """
        if reference is None:
            raise ValueError(
                "GPT-SoVITS needs a voice reference; give the persona a voice from data/voice_storage/."
            )
        lang = self.language(language)
        params = {
            "text": text,
            "text_lang": lang,
            "ref_audio_path": reference.engine_path(self.voice_dir),
            "prompt_lang": lang,
            "prompt_text": reference.transcript or "",
            "text_split_method": "cut5",
            "batch_size": 20,
            "media_type": "wav",
            "streaming_mode": "false",
        }
        response = await self.call("GET", "/tts", context="TTS synthesis", params=params, timeout=timeout)
        return response.content

    async def healthy(self) -> dict:
        """Reachability, not a status code.

        api_v2 has no health route, and it answers a request missing parameters
        with a 500 rather than a 400 — so a status check would report a healthy
        engine as down. Any answer at all is the proof that matters: the server
        builds its pipeline at import and binds afterwards, so a process that
        is listening has its models loaded.
        """
        try:
            response = await get_client().request("GET", f"{self.url}/tts", timeout=5)
        except httpx.HTTPError as e:
            logger.error("Speech health check against %s failed: %s", self.model_id, e, exc_info=True)
            return {"ok": False, "message": str(e)}
        return {"ok": True, "message": f"{self.model_id} is reachable (HTTP {response.status_code})"}

    def voices(self) -> list[dict]:
        """None: this engine clones from the reference clip and ships no presets."""
        return []
