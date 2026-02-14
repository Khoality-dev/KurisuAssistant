"""Gesture detection: YOLOv8-Pose (GPU) for body + MediaPipe Hands (CPU) for hand landmarks."""

import logging
import os
import urllib.request
from pathlib import Path
from typing import List, Optional

import numpy as np

from .base import BaseGestureDetector
from .classifier import classify_hand_gestures, classify_pose_gestures

logger = logging.getLogger(__name__)

MODEL_DIR = Path("data/gesture_detection/models")

HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
HAND_MODEL_FILE = "hand_landmarker.task"


def _ensure_model(filename: str, url: str) -> str:
    """Download model file if not present. Returns path."""
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / filename
    if not path.exists():
        logger.info("Downloading %s ...", filename)
        urllib.request.urlretrieve(url, str(path))
        logger.info("Downloaded %s", filename)
    return str(path)


class KeyPoint:
    """Lightweight landmark-like object for YOLO pose keypoints."""
    __slots__ = ("x", "y", "z", "visibility")

    def __init__(self, x: float, y: float, visibility: float):
        self.x = x
        self.y = y
        self.z = 0.0
        self.visibility = visibility


class MediaPipeGestureDetector(BaseGestureDetector):
    """Gesture detection: YOLOv8-Pose (CUDA) for body pose + MediaPipe Hands (CPU)."""

    def __init__(self):
        self._hand_landmarker = None
        self._yolo_pose = None
        self._frame_ts = 0

    def _ensure_pose(self):
        """Load YOLOv8-Pose on GPU if not already loaded."""
        if self._yolo_pose is not None:
            return
        from ultralytics import YOLO

        yolo_model_path = MODEL_DIR / "yolov8n-pose.pt"
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        self._yolo_pose = YOLO(str(yolo_model_path))
        self._yolo_pose.predict(
            np.zeros((480, 640, 3), dtype=np.uint8),
            device="cuda", verbose=False,
        )
        logger.info("YOLOv8-Pose loaded on CUDA")

    def _ensure_hands(self):
        """Load MediaPipe Hands on CPU if not already loaded."""
        if self._hand_landmarker is not None:
            return
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python.vision import (
            HandLandmarker,
            HandLandmarkerOptions,
            RunningMode,
        )

        hand_model_path = _ensure_model(HAND_MODEL_FILE, HAND_MODEL_URL)
        self._hand_landmarker = HandLandmarker.create_from_options(
            HandLandmarkerOptions(
                base_options=BaseOptions(
                    model_asset_path=hand_model_path,
                    delegate=BaseOptions.Delegate.CPU,
                ),
                running_mode=RunningMode.VIDEO,
                num_hands=2,
                min_hand_detection_confidence=0.7,
                min_hand_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
        )
        self._frame_ts = 0
        logger.info("MediaPipe Hands loaded on CPU")

    def _offload_pose(self):
        """Unload YOLOv8-Pose to free GPU memory."""
        if self._yolo_pose is None:
            return
        del self._yolo_pose
        self._yolo_pose = None
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("YOLOv8-Pose offloaded")

    def _offload_hands(self):
        """Unload MediaPipe Hands to free memory."""
        if self._hand_landmarker is None:
            return
        self._hand_landmarker.close()
        self._hand_landmarker = None
        logger.info("MediaPipe Hands offloaded")

    def detect_gestures(self, image: np.ndarray, *,
                        enable_pose: bool = True,
                        enable_hands: bool = True) -> dict:
        """Detect gestures and return results with raw landmarks for debug visualization.

        Loads/offloads models on demand based on enable flags.
        Returns dict with keys: gestures, pose_landmarks, hand_landmarks.
        """
        # Load what's needed, offload what's not
        if enable_pose:
            self._ensure_pose()
        else:
            self._offload_pose()

        if enable_hands:
            self._ensure_hands()
        else:
            self._offload_hands()

        import cv2

        # --- YOLO Pose (GPU) ---
        pose_landmarks = None
        if enable_pose and self._yolo_pose:
            yolo_results = self._yolo_pose.predict(
                image, device="cuda", verbose=False, conf=0.5
            )
            if yolo_results and yolo_results[0].keypoints is not None:
                kpts = yolo_results[0].keypoints
                if kpts.xyn is not None and len(kpts.xyn) > 0:
                    xyn = kpts.xyn[0].cpu().numpy()   # shape (17, 2)
                    conf = kpts.conf[0].cpu().numpy()  # shape (17,)
                    pose_landmarks = [
                        KeyPoint(float(xyn[i][0]), float(xyn[i][1]), float(conf[i]))
                        for i in range(17)
                    ]

        # --- MediaPipe Hands (CPU) ---
        hands_result = None
        if enable_hands and self._hand_landmarker:
            import mediapipe as mp
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            self._frame_ts += 33
            hands_result = self._hand_landmarker.detect_for_video(mp_image, self._frame_ts)

        gestures = []
        hand_landmarks_list = []

        if hands_result and hands_result.hand_landmarks:
            for hand_lms, handedness_list in zip(
                hands_result.hand_landmarks,
                hands_result.handedness,
            ):
                handedness = handedness_list[0].category_name  # "Left" or "Right"
                hand_gestures = classify_hand_gestures(
                    hand_lms,
                    handedness,
                    pose_landmarks,
                )
                gestures.extend(hand_gestures)
                hand_landmarks_list.append(hand_lms)

        # Pose-only gestures (works without hands enabled)
        if pose_landmarks:
            pose_gestures = classify_pose_gestures(pose_landmarks)
            gestures.extend(pose_gestures)

        # Deduplicate: keep highest confidence per gesture type
        best = {}
        for g in gestures:
            name = g["gesture"]
            if name not in best or g["confidence"] > best[name]["confidence"]:
                best[name] = g

        return {
            "gestures": list(best.values()),
            "pose_landmarks": pose_landmarks,
            "hand_landmarks": hand_landmarks_list,
        }
