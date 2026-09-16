"""TTS model registry — lazy init, lookup, listing."""

import logging
import threading
from typing import Optional

from universal_voice import config
from .base import BaseTTSModel

logger = logging.getLogger(__name__)


class TTSRegistry:
    """Registry of available TTS models. Lazily initializes on first access."""

    def __init__(self):
        self._models: dict[str, BaseTTSModel] = {}
        self._lock = threading.Lock()
        self._initialized = False

    def _ensure_initialized(self):
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self._register_all()
            self._initialized = True

    def _register_all(self):
        """Register all configured TTS models."""
        # VieNeu (always available — runs in-process)
        from .vieneu_model import VieNeuTTSModel
        vieneu = VieNeuTTSModel()
        self._models[vieneu.model_id] = vieneu

        # GPT-SoVITS (remote container)
        from .gpt_sovits_model import GPTSoVITSModel
        sovits = GPTSoVITSModel()
        self._models[sovits.model_id] = sovits

        # viXTTS (remote container)
        from .vixtts_model import ViXTTSModel
        vixtts = ViXTTSModel()
        self._models[vixtts.model_id] = vixtts

        logger.info(
            "TTS registry initialized with models: %s (default: %s)",
            list(self._models.keys()),
            config.TTS_DEFAULT_MODEL,
        )

    def get_model(self, model_id: Optional[str] = None) -> BaseTTSModel:
        """Get a TTS model by ID. Uses default if not specified."""
        self._ensure_initialized()
        name = model_id or config.TTS_DEFAULT_MODEL
        model = self._models.get(name)
        if model is None:
            raise ValueError(
                f"Unknown TTS model: {name}. "
                f"Available: {list(self._models.keys())}"
            )
        return model

    def list_models(self) -> list[dict]:
        """List all registered TTS models with metadata."""
        self._ensure_initialized()
        result = []
        for mid, model in self._models.items():
            result.append({
                "id": mid,
                "object": "model",
                "type": "tts",
                "loaded": model.is_loaded(),
            })
        return result


tts_registry = TTSRegistry()
