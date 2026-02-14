"""Vision frame processor for face recognition + gesture detection.

Architecture:
- Frontend captures webcam via getUserMedia, sends JPEG frames at DETECT_FPS
- Backend decodes frame, runs face + gesture detection, returns metadata
- No RTSP/MediaMTX — frames arrive directly over WebSocket
"""

import base64
import logging
from collections import deque
from typing import Optional

import cv2
import numpy as np

import face_recognition as face_rec_module
import gesture_detection as gesture_module
from db.session import get_session
from gesture_detection.classifier import classify_hand_gestures, classify_pose_trajectory

logger = logging.getLogger(__name__)

# Face matching threshold (cosine distance; lower = more similar)
FACE_MATCH_THRESHOLD = 0.6

# Pose trajectory buffer size (e.g. 15 frames ≈ 3s at 5 FPS)
POSE_HISTORY_SIZE = 15


def _batch_detect(
    frame: np.ndarray,
    face_provider,
    gesture_detector,
    enable_pose: bool,
    enable_hands: bool,
) -> dict:
    """Run all detection models on one frame."""
    result = {}

    if face_provider:
        result["faces_raw"] = face_provider.detect_and_embed(frame)
    else:
        result["faces_raw"] = []

    if gesture_detector:
        gesture_result = gesture_detector.detect_gestures(
            frame, enable_pose=enable_pose, enable_hands=enable_hands
        )
        result["hands"] = gesture_result.get("hands", [])
        result["pose_landmarks"] = gesture_result.get("pose_landmarks")
    else:
        result["hands"] = []
        result["pose_landmarks"] = None

    return result


class VisionProcessor:
    """Processes individual webcam frames for face/gesture detection.

    Frames are received from the frontend via WebSocket (base64 JPEG).
    Detection results are returned as metadata (no image encoding).
    """

    def __init__(self, user_id: int, *,
                 enable_face: bool = True,
                 enable_pose: bool = True,
                 enable_hands: bool = True):
        self.user_id = user_id
        self.enable_face = enable_face
        self.enable_pose = enable_pose
        self.enable_hands = enable_hands
        self._embedding_cache: Optional[list] = None
        self._processing = False
        self._pose_history: deque = deque(maxlen=POSE_HISTORY_SIZE)

        # Eagerly load providers
        self._face_provider = face_rec_module.get_provider() if enable_face else None
        self._gesture_detector = gesture_module.get_provider() if (enable_pose or enable_hands) else None

        logger.info("Vision processor initialized for user %d (face=%s, pose=%s, hands=%s)",
                     user_id, enable_face, enable_pose, enable_hands)

    def process_frame(self, frame_b64: str) -> Optional[dict]:
        """Decode a base64 JPEG frame and run detection. Returns result dict or None if busy."""
        if self._processing:
            return None  # Skip frame — previous inference still running
        self._processing = True

        try:
            # Decode base64 JPEG → numpy array
            frame_bytes = base64.b64decode(frame_b64)
            frame_arr = np.frombuffer(frame_bytes, dtype=np.uint8)
            frame = cv2.imdecode(frame_arr, cv2.IMREAD_COLOR)
            if frame is None:
                logger.warning("Failed to decode frame")
                return None

            # Run detection
            detect_result = _batch_detect(
                frame, self._face_provider, self._gesture_detector,
                self.enable_pose, self.enable_hands,
            )

            # Match faces
            faces_raw = detect_result["faces_raw"]
            if self._face_provider and faces_raw:
                recognized = self._match_faces(faces_raw)
            else:
                recognized = []

            # Accumulate pose landmarks for trajectory analysis
            pose_landmarks = detect_result["pose_landmarks"]
            self._pose_history.append(pose_landmarks)

            # Classify hand gestures per-frame from current landmarks
            hand_gestures = []
            for hand in detect_result["hands"]:
                hand_gestures.extend(classify_hand_gestures(
                    hand["landmarks"], hand["handedness"], pose_landmarks,
                ))

            # Pose gestures come from trajectory (wrist oscillation over time)
            pose_gestures = classify_pose_trajectory(list(self._pose_history))

            # Merge: deduplicate keeping highest confidence per gesture type
            all_gestures = hand_gestures + pose_gestures
            best = {}
            for g in all_gestures:
                name = g["gesture"]
                if name not in best or g["confidence"] > best[name]["confidence"]:
                    best[name] = g
            gestures = list(best.values())

            return {
                "faces": recognized,
                "gestures": gestures,
            }
        except Exception as e:
            logger.error("Frame processing error: %s", e, exc_info=True)
            return None
        finally:
            self._processing = False

    # ----- Embedding cache + matching -----

    def _load_embedding_cache(self):
        from db.models import FacePhoto, FaceIdentity
        from sqlalchemy import select

        entries = []
        with get_session() as session:
            stmt = (
                select(
                    FacePhoto.id,
                    FacePhoto.embedding,
                    FaceIdentity.id.label("identity_id"),
                    FaceIdentity.name.label("identity_name"),
                )
                .join(FaceIdentity, FacePhoto.identity_id == FaceIdentity.id)
                .where(FaceIdentity.user_id == self.user_id)
            )
            for row in session.execute(stmt):
                emb = np.array(row.embedding, dtype=np.float32)
                norm = np.linalg.norm(emb)
                if norm > 0:
                    emb = emb / norm
                entries.append({
                    "identity_id": row.identity_id,
                    "name": row.identity_name,
                    "embedding": emb,
                })
        self._embedding_cache = entries
        logger.info("Loaded %d face embeddings into cache for user %d", len(entries), self.user_id)

    def _match_faces(self, faces_raw: list) -> list:
        if not faces_raw:
            return []
        if self._embedding_cache is None:
            self._load_embedding_cache()

        recognized = []
        for face in faces_raw:
            query = np.array(face["embedding"], dtype=np.float32)
            norm = np.linalg.norm(query)
            if norm > 0:
                query = query / norm

            best_match = None
            best_dist = float("inf")
            for entry in self._embedding_cache:
                dist = 1.0 - float(np.dot(query, entry["embedding"]))
                if dist < best_dist:
                    best_dist = dist
                    best_match = entry

            if best_match and best_dist < FACE_MATCH_THRESHOLD:
                recognized.append({
                    "identity_id": best_match["identity_id"],
                    "name": best_match["name"],
                    "confidence": 1.0 - best_dist,
                    "bbox": face["bbox"],
                })
            else:
                recognized.append({
                    "identity_id": None,
                    "name": "Unknown",
                    "confidence": face["score"],
                    "bbox": face["bbox"],
                })
        return recognized
