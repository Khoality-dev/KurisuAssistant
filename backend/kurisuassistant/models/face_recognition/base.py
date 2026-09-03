"""Abstract base class for face recognition providers."""

from abc import ABC, abstractmethod
from typing import List

import numpy as np


class BaseFaceRecognitionProvider(ABC):
    """Abstract base for face detection + embedding providers."""

    @abstractmethod
    def detect_and_embed(self, image: np.ndarray) -> List[dict]:
        """Detect faces and compute embeddings from an image.

        Args:
            image: BGR numpy array (OpenCV format).

        Returns:
            List of dicts, each with:
                - bbox: [x1, y1, x2, y2] face bounding box
                - embedding: 512-dim float list (ArcFace)
                - score: detection confidence (0-1)
        """
        ...
