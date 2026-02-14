"""Abstract base class for ASR providers."""

from abc import ABC, abstractmethod

import numpy as np


class BaseASRProvider(ABC):
    """Abstract base for speech-to-text providers."""

    @abstractmethod
    def transcribe(self, audio: np.ndarray, language: str | None = None) -> str:
        """Transcribe audio waveform to text.

        Args:
            audio: Float32 numpy array of audio samples (16kHz mono).
            language: Optional language hint (e.g. "en", "ja").

        Returns:
            Transcribed text string.
        """
        ...
