"""Model manager — download, convert, cache, list, delete models."""

import json
import logging
import os
import re
import shutil
import threading

from universal_voice import config

logger = logging.getLogger(__name__)

# Standard Whisper size keywords that faster-whisper can download directly as CT2
_WHISPER_SIZES = {
    "tiny", "tiny.en", "base", "base.en",
    "small", "small.en", "medium", "medium.en",
    "large", "large-v1", "large-v2", "large-v3",
    "distil-large-v2", "distil-large-v3",
    "turbo",
}


def _safe_name(model_name: str) -> str:
    """Convert model name to a filesystem-safe directory name."""
    return re.sub(r"[^\w\-.]", "_", model_name)


class ModelManager:
    """Manages model lifecycle: resolve, download, convert, cache, list, delete."""

    def __init__(self):
        self._lock = threading.Lock()

    def _models_dir(self) -> str:
        os.makedirs(config.MODELS_DIR, exist_ok=True)
        return config.MODELS_DIR

    def _model_cache_path(self, model_name: str) -> str:
        return os.path.join(self._models_dir(), _safe_name(model_name))

    def resolve_model(self, model_name: str) -> str:
        """Resolve a model name to a local CT2 model path.

        1. If already cached locally, return path.
        2. If standard Whisper size keyword, download via faster-whisper into our cache.
        3. Otherwise, download from HuggingFace and auto-convert to CT2.
        """
        cache_path = self._model_cache_path(model_name)

        # Already cached
        if os.path.isdir(cache_path) and os.path.exists(os.path.join(cache_path, "model.bin")):
            logger.info("Model cached: %s -> %s", model_name, cache_path)
            return cache_path

        with self._lock:
            # Double-check after acquiring lock
            if os.path.isdir(cache_path) and os.path.exists(os.path.join(cache_path, "model.bin")):
                return cache_path

            if model_name in _WHISPER_SIZES:
                self._download_whisper(model_name, cache_path)
            else:
                self._download_and_convert(model_name, cache_path)
        return cache_path

    def _download_whisper(self, model_name: str, output_path: str):
        """Download a standard Whisper model via faster-whisper into our cache."""
        from faster_whisper.utils import download_model

        logger.info("Downloading standard Whisper model: %s", model_name)
        os.makedirs(output_path, exist_ok=True)
        download_model(model_name, output_dir=output_path)
        logger.info("Whisper model downloaded: %s -> %s", model_name, output_path)

    def _download_and_convert(self, model_name: str, output_path: str):
        """Download a HuggingFace transformers Whisper model and convert to CT2."""
        import ctranslate2
        import transformers

        logger.info("Downloading HuggingFace model: %s", model_name)
        model = transformers.WhisperForConditionalGeneration.from_pretrained(model_name)
        processor = transformers.WhisperProcessor.from_pretrained(model_name)

        logger.info("Converting to CTranslate2 format -> %s", output_path)
        converter = ctranslate2.converters.TransformersConverter(model_name)
        # Inject already-loaded model to avoid re-download
        converter.load_model = lambda *a, **kw: model

        os.makedirs(output_path, exist_ok=True)
        converter.convert(output_path, quantization=config.COMPUTE_TYPE, force=True)

        # Save processor/tokenizer files alongside the model
        processor.save_pretrained(output_path)
        logger.info("Model converted and cached: %s", output_path)

    def list_models(self) -> list[dict]:
        """List all cached models with metadata."""
        models = []
        models_dir = self._models_dir()
        if not os.path.isdir(models_dir):
            return models

        for entry in sorted(os.listdir(models_dir)):
            model_path = os.path.join(models_dir, entry)
            if not os.path.isdir(model_path):
                continue
            if not os.path.exists(os.path.join(model_path, "model.bin")):
                continue

            # Calculate size
            total_size = 0
            for dirpath, _dirnames, filenames in os.walk(model_path):
                for f in filenames:
                    total_size += os.path.getsize(os.path.join(dirpath, f))

            # Try to read original model name from config
            original_name = entry
            config_path = os.path.join(model_path, "preprocessor_config.json")
            if os.path.exists(config_path):
                try:
                    with open(config_path) as f:
                        data = json.load(f)
                    original_name = data.get("_name_or_path", entry) or entry
                except Exception:
                    pass

            models.append({
                "id": entry,
                "name": original_name,
                "size_bytes": total_size,
                "size_mb": round(total_size / (1024 * 1024), 1),
                "path": model_path,
            })
        return models

    def delete_model(self, model_name: str) -> bool:
        """Delete a cached model. Returns True if deleted."""
        cache_path = self._model_cache_path(model_name)
        if os.path.isdir(cache_path):
            shutil.rmtree(cache_path)
            logger.info("Deleted model: %s", cache_path)
            return True

        # Also try matching by directory name directly
        direct_path = os.path.join(self._models_dir(), model_name)
        if os.path.isdir(direct_path):
            shutil.rmtree(direct_path)
            logger.info("Deleted model: %s", direct_path)
            return True

        return False

    def is_cached(self, model_name: str) -> bool:
        """Check if a model is already cached."""
        cache_path = self._model_cache_path(model_name)
        return os.path.isdir(cache_path) and os.path.exists(os.path.join(cache_path, "model.bin"))


model_manager = ModelManager()
