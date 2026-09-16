"""viXTTS — XTTS-v2 fine-tuned for Vietnamese (capleaf/viXTTS), in this process.

It used to be a container of its own, built from a checkout beside this
repository (``VIXTTS_ROOT``) and reached over HTTP (#203). The model is loaded
through coqui-tts; the one thing the fine-tune's fork of that library added —
Vietnamese in the tokenizer — is patched onto the class at load time, see
``_teach_tokenizer_vietnamese``.
"""

import gc
import hashlib
import io
import logging
import re
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf

from universal_voice import config
from .base import BaseTTSModel
from .text_processing import merge_wav_files, split_text

logger = logging.getLogger(__name__)

# XTTS-v2's seventeen, plus the one the fine-tune adds.
SUPPORTED_LANGUAGES = frozenset({
    "ar", "cs", "de", "en", "es", "fr", "hi", "hu", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "vi", "zh",
})
LANGUAGE_ALIASES = {"zh-cn": "zh", "jp": "ja"}
DEFAULT_LANGUAGE = "vi"
REQUIRED_FILES = ("config.json", "model.pth", "vocab.json", "speakers_xtts.pth")
# From the fine-tune; the speaker presets come from the base model instead.
FINE_TUNE_FILES = ("config.json", "model.pth", "vocab.json", "README.md", "LICENSE*")
SAMPLE_RATE = 24_000
GPT_COND_LEN = 12
MAX_REF_LENGTH = 30


def normalize_language(language: Optional[str]) -> str:
    lang = (language or DEFAULT_LANGUAGE).strip().lower()
    lang = LANGUAGE_ALIASES.get(lang, lang)
    if lang not in SUPPORTED_LANGUAGES:
        raise ValueError(
            f"viXTTS does not support language '{language}'. "
            f"Supported: {', '.join(sorted(SUPPORTED_LANGUAGES | set(LANGUAGE_ALIASES)))}"
        )
    return lang


def vietnamese_cleaner(text: str) -> str:
    """What the fine-tune was trained on: lower-cased, whitespace collapsed — the
    ``basic_cleaners`` of the fork that served it."""
    return re.sub(r"\s+", " ", text.lower())


def _teach_tokenizer_vietnamese() -> None:
    """coqui-tts's ``VoiceBpeTokenizer`` raises for a language XTTS-v2 was not
    trained on. thinhlpg/TTS, the fork the old container installed, differed
    from upstream in exactly two places: a 250-character limit for ``vi`` and
    ``basic_cleaners`` as its preprocessing. The same two things, on the class,
    once."""
    from TTS.tts.layers.xtts import tokenizer as xtts_tokenizer

    cls = xtts_tokenizer.VoiceBpeTokenizer
    if getattr(cls, "_vietnamese", False):
        return
    original_init = cls.__init__
    original_preprocess = cls.preprocess_text

    def __init__(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.char_limits.setdefault("vi", 250)

    def preprocess_text(self, txt, lang):
        if lang == "vi":
            return vietnamese_cleaner(txt)
        return original_preprocess(self, txt, lang)

    cls.__init__ = __init__
    cls.preprocess_text = preprocess_text
    cls._vietnamese = True


class ViXTTSModel(BaseTTSModel):
    """Voice cloning from an uploaded clip, or one of XTTS-v2's preset speakers."""

    def __init__(self):
        self._model: Any = None
        self._offloaded = False
        self._normalizer = None
        self._load_lock = threading.Lock()
        # XTTS is not thread-safe, and one GPU: syntheses are serialised.
        self._infer_lock = threading.Lock()
        self._latents: "OrderedDict[str, tuple]" = OrderedDict()

    @property
    def model_id(self) -> str:
        return "vixtts"

    # --- weights -----------------------------------------------------------

    def _model_dir(self) -> Path:
        return Path(config.TTS_MODELS_DIR) / "vixtts"

    def _ensure_files(self) -> Path:
        model_dir = self._model_dir()
        model_dir.mkdir(parents=True, exist_ok=True)
        missing = [name for name in REQUIRED_FILES if not (model_dir / name).exists()]
        if not missing:
            return model_dir
        from huggingface_hub import hf_hub_download, snapshot_download

        logger.info("viXTTS: fetching %s into %s (missing %s)", config.VIXTTS_MODEL_ID, model_dir, missing)
        snapshot_download(
            repo_id=config.VIXTTS_MODEL_ID, local_dir=str(model_dir), allow_patterns=list(FINE_TUNE_FILES),
        )
        if not (model_dir / "speakers_xtts.pth").exists():
            hf_hub_download(
                repo_id=config.VIXTTS_BASE_MODEL_ID, filename="speakers_xtts.pth", local_dir=str(model_dir),
            )
        return model_dir

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None:
                if self._offloaded:
                    self._model.to(config.DEVICE)
                    self._offloaded = False
                    logger.info("viXTTS back on %s", config.DEVICE)
                return
            _teach_tokenizer_vietnamese()
            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts

            model_dir = self._ensure_files()
            xtts_config = XttsConfig()
            xtts_config.load_json(str(model_dir / "config.json"))
            model = Xtts.init_from_config(xtts_config)
            model.load_checkpoint(xtts_config, checkpoint_dir=str(model_dir), eval=True)
            if config.DEVICE == "cuda":
                model.cuda()
            try:
                from vinorm import TTSnorm

                self._normalizer = TTSnorm
            except Exception:  # noqa: BLE001 — vinorm ships a binary; keep speaking without it
                logger.warning("vinorm unavailable; Vietnamese text is synthesised unnormalised", exc_info=True)
            self._model = model
            self._offloaded = False
            logger.info("viXTTS loaded on %s from %s", config.DEVICE, model_dir)

    def offload(self) -> bool:
        with self._load_lock:
            if self._model is None or self._offloaded:
                return self._model is not None
            self._model.to("cpu")
            self._latents.clear()  # device tensors; a second to recompute
            self._offloaded = True
            _release_device_memory()
        return True

    def unload(self) -> None:
        with self._load_lock:
            self._model = None
            self._offloaded = False
            self._latents.clear()
            _release_device_memory()

    # --- conditioning ------------------------------------------------------

    def _speakers(self) -> dict:
        manager = getattr(self._model, "speaker_manager", None)
        speakers = getattr(manager, "speakers", None)
        return speakers if isinstance(speakers, dict) else {}

    def _preset(self, voice_id: Optional[str]) -> tuple:
        speakers = self._speakers()
        if not speakers:
            raise RuntimeError("viXTTS has no preset speakers loaded; pass ref_audio")
        if voice_id:
            if voice_id not in speakers:
                raise ValueError(f"Unknown viXTTS voice_id '{voice_id}'")
            name = voice_id
        else:
            name = sorted(speakers)[0]
        data = speakers[name]
        return data["gpt_cond_latent"], data["speaker_embedding"]

    def _cloned(self, ref_audio_bytes: bytes, filename: Optional[str]) -> tuple:
        key = hashlib.sha256(ref_audio_bytes).hexdigest()
        cached = self._latents.get(key)
        if cached is not None:
            self._latents.move_to_end(key)
            return cached
        suffix = Path(filename or "").suffix.lower() or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(ref_audio_bytes)
            ref_path = handle.name
        try:
            latents = self._model.get_conditioning_latents(
                audio_path=[ref_path], gpt_cond_len=GPT_COND_LEN, max_ref_length=MAX_REF_LENGTH, sound_norm_refs=False,
            )
        finally:
            Path(ref_path).unlink(missing_ok=True)
        self._latents[key] = latents
        while len(self._latents) > max(1, config.VIXTTS_SPEAKER_CACHE_SIZE):
            self._latents.popitem(last=False)
        return latents

    def _normalize_text(self, text: str, lang: str) -> str:
        text = " ".join(text.split())
        if lang == "vi" and self._normalizer is not None:
            try:
                text = self._normalizer(text, unknown=False, lower=False, rule=True)
            except Exception:  # noqa: BLE001
                logger.warning("Vietnamese normalisation failed; using the raw text", exc_info=True)
        return text.strip()

    # --- BaseTTSModel ------------------------------------------------------

    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
        ref_audio_bytes: Optional[bytes] = None,
        ref_text: Optional[str] = None,
        **kwargs,
    ) -> bytes:
        self.load()
        lang = normalize_language(language)
        chunks = split_text(text, max_length=kwargs.get("max_chunk_length", 200))
        logger.debug("viXTTS: %d chunk(s), language=%s", len(chunks), lang)
        with self._infer_lock:
            if ref_audio_bytes:
                gpt_cond_latent, speaker_embedding = self._cloned(ref_audio_bytes, kwargs.get("ref_audio_filename"))
            else:
                gpt_cond_latent, speaker_embedding = self._preset(voice_id)
            wavs = []
            for chunk in chunks:
                normalized = self._normalize_text(chunk, lang)
                if not normalized:
                    continue
                result = self._model.inference(
                    text=normalized,
                    language=lang,
                    gpt_cond_latent=gpt_cond_latent,
                    speaker_embedding=speaker_embedding,
                    enable_text_splitting=True,
                )
                wavs.append(_wav_bytes(result["wav"], int(result.get("sample_rate", SAMPLE_RATE))))
        if not wavs:
            raise ValueError("Text is empty after normalisation")
        return merge_wav_files(wavs)

    def list_voices(self) -> list[dict]:
        self.load()
        return [{"id": name, "name": name} for name in sorted(self._speakers())]

    def check_health(self) -> dict:
        if self._model is None:
            return {"ok": False, "message": "viXTTS not loaded yet"}
        return {"ok": True, "message": f"viXTTS loaded on {config.DEVICE}"}

    def is_loaded(self) -> Optional[bool]:
        return self._model is not None


def _release_device_memory() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _wav_bytes(wav, sample_rate: int) -> bytes:
    if hasattr(wav, "cpu"):
        wav = wav.cpu().numpy()
    audio = np.asarray(wav, dtype=np.float32).reshape(-1)
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
