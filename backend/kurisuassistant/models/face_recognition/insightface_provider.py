"""InsightFace (ArcFace) face recognition provider."""

import logging
import os
from typing import List

import numpy as np

from kurisuassistant.core.paths import DATA_DIR

from .base import BaseFaceRecognitionProvider

logger = logging.getLogger(__name__)

# Beside the rest of the server's data, not under the working directory (#307).
MODEL_DIR = str(DATA_DIR / "face_recognition" / "models")


class InsightFaceProvider(BaseFaceRecognitionProvider):
    """Face recognition provider using InsightFace (buffalo_l / ArcFace 512-dim)."""

    def __init__(self):
        self._app = None

    def _get_app(self):
        """Lazily load InsightFace FaceAnalysis on first use."""
        if self._app is None:
            from insightface.app import FaceAnalysis

            os.makedirs(MODEL_DIR, exist_ok=True)

            import onnxruntime
            available = onnxruntime.get_available_providers()
            providers = [p for p in ["CUDAExecutionProvider", "CPUExecutionProvider"] if p in available]

            logger.info("Loading InsightFace model (buffalo_l) from %s (providers: %s)", MODEL_DIR, providers)
            self._app = FaceAnalysis(
                name="buffalo_l",
                root=MODEL_DIR,
                providers=providers,
            )
            self._app.prepare(ctx_id=0, det_size=(640, 640))
            logger.info("InsightFace model loaded")
        return self._app

    def detect_and_embed(self, image: np.ndarray) -> List[dict]:
        app = self._get_app()
        faces = app.get(image)

        results = []
        for face in faces:
            if face.embedding is None:
                continue
            results.append({
                "bbox": face.bbox.tolist(),
                "embedding": face.embedding.tolist(),
                "score": float(face.det_score),
            })
        return results
