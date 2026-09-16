"""GPT-SoVITS v2, in this process, from the vendored inference code.

It used to be a third-party image (``legwork7623/gpt-sovits:latest``, unpinned)
behind a second profile, handed each reference clip through a volume both
containers mounted (#203). The inference code is ``voice/vendor/gpt_sovits``;
the pretrained weights come from the Hugging Face repository on first use, into
the data volume. Only v2 is wired up: the v3/v4 vocoders in the vendored
``TTS.py`` still resolve their weights relative to the working directory.
"""

import gc
import hashlib
import io
import logging
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
from .vendor import ensure_gpt_sovits_importable

logger = logging.getLogger(__name__)

# Relative to the Hugging Face repository, and to the local snapshot of it.
PRETRAINED = {
    "bert": "chinese-roberta-wwm-ext-large",
    "hubert": "chinese-hubert-base",
    "gpt": "gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
    "sovits": "gsv-v2final-pretrained/s2G2333k.pth",
}
ALLOW_PATTERNS = [f"{PRETRAINED['bert']}/*", f"{PRETRAINED['hubert']}/*", PRETRAINED["gpt"], PRETRAINED["sovits"]]
# TTS_Config.v2_languages, as upstream names them.
LANGUAGES = ("auto", "auto_yue", "en", "zh", "ja", "yue", "ko", "all_zh", "all_ja", "all_yue", "all_ko")
LANGUAGE_ALIASES = {"zh-cn": "zh", "jp": "ja", "en-us": "en", "en-gb": "en"}
REF_CACHE_SIZE = 8
PLACEHOLDER_RATE = 16_000  # what upstream yields, as a second of silence, for a chunk it cannot say


def normalize_language(language: Optional[str]) -> str:
    lang = (language or config.GPTSOVITS_DEFAULT_LANGUAGE).strip().lower()
    lang = LANGUAGE_ALIASES.get(lang, lang)
    if lang not in LANGUAGES:
        raise ValueError(
            f"GPT-SoVITS does not support language '{language}'. Supported: {', '.join(LANGUAGES)}"
        )
    return lang


class GPTSoVITSModel(BaseTTSModel):
    """Voice cloning from a reference clip; there are no preset voices."""

    def __init__(self):
        self._tts: Any = None
        self._offloaded = False
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        # Reference clips on disk, keyed by content hash. Upstream caches the
        # encoded prompt by *path*, so giving the same bytes the same path is
        # what lets a persona's clip be encoded once rather than per request.
        self._ref_files: "OrderedDict[str, Path]" = OrderedDict()

    @property
    def model_id(self) -> str:
        return "gpt-sovits"

    # --- weights -----------------------------------------------------------

    def _root(self) -> Path:
        return Path(config.TTS_MODELS_DIR) / "gpt-sovits"

    def _ensure_files(self) -> dict[str, Path]:
        root = self._root()
        root.mkdir(parents=True, exist_ok=True)
        paths = {name: root / rel for name, rel in PRETRAINED.items()}
        overrides = {"gpt": config.GPTSOVITS_GPT_WEIGHTS, "sovits": config.GPTSOVITS_SOVITS_WEIGHTS}
        for name, override in overrides.items():
            if override:
                paths[name] = Path(override)
                if not paths[name].exists():
                    raise RuntimeError(
                        f"UVOICE_GPTSOVITS_{name.upper()}_WEIGHTS points at {override}, which does not exist"
                    )
        missing = [name for name, path in paths.items() if not path.exists()]
        if missing:
            from huggingface_hub import snapshot_download

            logger.info("GPT-SoVITS: fetching %s into %s (missing %s)", config.GPTSOVITS_PRETRAINED_REPO, root, missing)
            snapshot_download(repo_id=config.GPTSOVITS_PRETRAINED_REPO, local_dir=str(root), allow_patterns=ALLOW_PATTERNS)
        for name, path in paths.items():
            if not path.exists():
                raise RuntimeError(f"GPT-SoVITS {name} weights missing at {path}")
        return paths

    # The torch modules upstream's TTS object holds for v2.
    _MODULES = ("t2s_model", "vits_model", "bert_model", "cnhuhbert_model", "vocoder", "sr_model")

    def _move(self, device: str) -> None:
        for name in self._MODULES:
            module = getattr(self._tts, name, None)
            if module is not None and hasattr(module, "to"):
                module.to(device)

    def load(self) -> None:
        with self._load_lock:
            if self._tts is not None:
                if self._offloaded:
                    self._move(config.DEVICE)
                    self._offloaded = False
                    logger.info("GPT-SoVITS back on %s", config.DEVICE)
                return
            paths = self._ensure_files()
            ensure_gpt_sovits_importable(
                bert_path=str(paths["bert"]), g2pw_model_dir=str(self._root() / "G2PWModel"),
            )
            from TTS_infer_pack.TTS import TTS, TTS_Config

            custom = {
                "device": config.DEVICE,
                "is_half": config.DEVICE == "cuda",
                "version": "v2",
                "t2s_weights_path": str(paths["gpt"]),
                "vits_weights_path": str(paths["sovits"]),
                "bert_base_path": str(paths["bert"]),
                "cnhuhbert_base_path": str(paths["hubert"]),
            }
            self._tts = TTS(TTS_Config({"version": "v2", "custom": custom}))
            self._offloaded = False
            logger.info("GPT-SoVITS loaded on %s (gpt=%s, sovits=%s)", config.DEVICE, paths["gpt"].name, paths["sovits"].name)

    def offload(self) -> bool:
        with self._load_lock:
            if self._tts is None or self._offloaded:
                return self._tts is not None
            self._move("cpu")
            self._offloaded = True
            _release_device_memory()
        return True

    def unload(self) -> None:
        with self._load_lock:
            self._tts = None
            self._offloaded = False
            _release_device_memory()

    # --- reference clips ---------------------------------------------------

    def _ref_path(self, ref_audio_bytes: bytes, filename: Optional[str]) -> Path:
        digest = hashlib.sha256(ref_audio_bytes).hexdigest()
        path = self._ref_files.get(digest)
        if path is not None and path.exists():
            self._ref_files.move_to_end(digest)
            return path
        suffix = Path(filename or "").suffix.lower() or ".wav"
        ref_dir = Path(tempfile.gettempdir()) / "uvoice-gpt-sovits"
        ref_dir.mkdir(parents=True, exist_ok=True)
        path = ref_dir / f"{digest}{suffix}"
        path.write_bytes(ref_audio_bytes)
        self._ref_files[digest] = path
        while len(self._ref_files) > REF_CACHE_SIZE:
            _, old = self._ref_files.popitem(last=False)
            old.unlink(missing_ok=True)
        return path

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
        if not ref_audio_bytes:
            raise RuntimeError(
                "GPT-SoVITS requires a voice reference for synthesis. Pass ref_audio with the request."
            )
        self.load()
        lang = normalize_language(language)
        chunks = split_text(text, max_length=kwargs.get("max_chunk_length", 200))
        logger.debug("GPT-SoVITS: %d chunk(s), language=%s", len(chunks), lang)
        with self._infer_lock:
            ref_path = self._ref_path(ref_audio_bytes, kwargs.get("ref_audio_filename"))
            wavs = []
            for chunk in chunks:
                inputs = {
                    "text": chunk,
                    "text_lang": lang,
                    "ref_audio_path": str(ref_path),
                    "prompt_text": ref_text or "",
                    "prompt_lang": lang,
                    "text_split_method": kwargs.get("text_split_method", "cut5"),
                    "batch_size": kwargs.get("batch_size", 20),
                    "return_fragment": False,
                }
                for sample_rate, audio in self._tts.run(inputs):
                    audio = np.asarray(audio)
                    if sample_rate == PLACEHOLDER_RATE and not audio.any():
                        continue
                    wavs.append(_wav_bytes(audio, int(sample_rate)))
        if not wavs:
            raise ValueError("GPT-SoVITS produced no audio for this text")
        return merge_wav_files(wavs)

    def list_voices(self) -> list[dict]:
        return []

    def check_health(self) -> dict:
        if self._tts is None:
            return {"ok": False, "message": "GPT-SoVITS not loaded yet"}
        return {"ok": True, "message": f"GPT-SoVITS loaded on {config.DEVICE}"}

    def is_loaded(self) -> Optional[bool]:
        return self._tts is not None


def _release_device_memory() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
