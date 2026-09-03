"""Abstract base class for gesture detection providers."""

from abc import ABC, abstractmethod
from typing import List

import numpy as np


class BaseGestureDetector(ABC):
    """Abstract base for gesture detection from images."""

    @abstractmethod
    def detect_gestures(self, image: np.ndarray) -> List[dict]:
        """Detect gestures in an image.

        Args:
            image: BGR numpy array (OpenCV format).

        Returns:
            List of dicts, each with:
                - gesture: str (e.g. "wave", "thumbs_up", "peace_sign")
                - confidence: float (0-1)
        """
        ...
