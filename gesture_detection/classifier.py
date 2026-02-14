"""Rule-based gesture classification from MediaPipe/YOLO landmarks."""

import logging
import math
from typing import List, Optional

logger = logging.getLogger(__name__)


def _distance(p1, p2) -> float:
    """Euclidean distance between two landmark points."""
    return math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2 + (p1.z - p2.z) ** 2)


def _is_finger_extended(landmarks, tip_idx: int, pip_idx: int, mcp_idx: int) -> bool:
    """Check if a finger is extended by comparing tip-to-mcp vs pip-to-mcp distances."""
    tip = landmarks[tip_idx]
    pip = landmarks[pip_idx]
    mcp = landmarks[mcp_idx]
    # Finger is extended if tip is farther from MCP than PIP is
    return _distance(tip, mcp) > _distance(pip, mcp)


def _is_thumb_extended(landmarks, is_right_hand: bool) -> bool:
    """Check if thumb is extended (special case - lateral movement)."""
    thumb_tip = landmarks[4]
    thumb_ip = landmarks[3]
    thumb_mcp = landmarks[2]
    index_mcp = landmarks[5]
    # Thumb is extended if tip is far from index MCP
    return _distance(thumb_tip, index_mcp) > _distance(thumb_mcp, index_mcp)


def _get_finger_states(hand_landmarks, is_right_hand: bool) -> dict:
    """Get extension state of each finger.

    Returns dict with keys: thumb, index, middle, ring, pinky (bool).
    """
    lm = hand_landmarks
    return {
        "thumb": _is_thumb_extended(lm, is_right_hand),
        "index": _is_finger_extended(lm, 8, 6, 5),
        "middle": _is_finger_extended(lm, 12, 10, 9),
        "ring": _is_finger_extended(lm, 16, 14, 13),
        "pinky": _is_finger_extended(lm, 20, 18, 17),
    }


def classify_hand_gestures(
    hand_landmarks,
    handedness: str,
    pose_landmarks=None,
) -> List[dict]:
    """Classify gestures from a single hand's landmarks.

    Args:
        hand_landmarks: MediaPipe hand landmarks (21 points).
        handedness: "Left" or "Right".
        pose_landmarks: Optional MediaPipe pose landmarks (33 points) for body context.

    Returns:
        List of detected gestures with confidence.
    """
    is_right = handedness == "Right"
    fingers = _get_finger_states(hand_landmarks, is_right)
    gestures = []

    # Thumbs up: thumb extended, all others curled
    if (
        fingers["thumb"]
        and not fingers["index"]
        and not fingers["middle"]
        and not fingers["ring"]
        and not fingers["pinky"]
    ):
        # Check thumb is pointing upward (tip.y < ip.y in normalized coords)
        if hand_landmarks[4].y < hand_landmarks[3].y:
            gestures.append({"gesture": "thumbs_up", "confidence": 0.9})

    # Peace sign: index + middle extended, others curled
    if (
        fingers["index"]
        and fingers["middle"]
        and not fingers["ring"]
        and not fingers["pinky"]
        and not fingers["thumb"]
    ):
        gestures.append({"gesture": "peace_sign", "confidence": 0.9})

    # Pointing: only index extended
    if (
        fingers["index"]
        and not fingers["middle"]
        and not fingers["ring"]
        and not fingers["pinky"]
    ):
        gestures.append({"gesture": "pointing", "confidence": 0.85})

    # Open palm: all fingers extended
    if all(fingers.values()):
        gestures.append({"gesture": "open_palm", "confidence": 0.9})

    return gestures


def classify_pose_trajectory(landmark_buffer: list) -> List[dict]:
    """Classify gestures from pose keypoint trajectory over a sliding window.

    Detects wave by tracking wrist X oscillation across frames.

    YOLO COCO keypoints:
        5=l_shoulder, 6=r_shoulder, 7=l_elbow, 8=r_elbow,
        9=l_wrist, 10=r_wrist

    Args:
        landmark_buffer: List of pose_landmarks snapshots (oldest first).
            Each entry is a list of KeyPoint objects or None.

    Returns:
        List of detected gestures with confidence.
    """
    if not landmark_buffer:
        return []

    MIN_VIS = 0.2
    MIN_REVERSALS = 3      # >= 3 direction changes = 1.5 back-and-forth cycles
    MIN_AMPLITUDE = 0.08   # Minimum wrist X range (8% of frame width)
    MIN_MOTION = 0.015     # Minimum per-frame movement to count (filters jitter)

    gestures = []

    for side, shoulder_idx, wrist_idx in [
        ("left", 5, 9),
        ("right", 6, 10),
    ]:
        # Precondition: wrist above shoulder in the latest frame
        latest = landmark_buffer[-1]
        if not latest or len(latest) < 11:
            continue

        shoulder = latest[shoulder_idx]
        wrist = latest[wrist_idx]
        if shoulder.visibility < MIN_VIS or wrist.visibility < MIN_VIS:
            continue
        if wrist.y >= shoulder.y:
            continue

        # Collect wrist X values across the buffer (skip missing frames)
        xs = []
        for frame_lms in landmark_buffer:
            if not frame_lms or len(frame_lms) < 11:
                continue
            w = frame_lms[wrist_idx]
            if w.visibility >= MIN_VIS:
                xs.append(w.x)

        if len(xs) < 3:
            continue

        # Count direction reversals in wrist X (ignore sub-threshold jitter)
        reversals = 0
        prev_dir = 0  # -1 = moving left, +1 = moving right
        for i in range(1, len(xs)):
            diff = xs[i] - xs[i - 1]
            if abs(diff) < MIN_MOTION:
                continue
            cur_dir = 1 if diff > 0 else -1
            if prev_dir != 0 and cur_dir != prev_dir:
                reversals += 1
            prev_dir = cur_dir

        amplitude = max(xs) - min(xs)

        if reversals >= MIN_REVERSALS and amplitude >= MIN_AMPLITUDE:
            # Confidence scales with reversals and amplitude
            conf = min(0.5 + reversals * 0.15 + amplitude * 2.0, 0.95)
            gestures.append({"gesture": "wave", "confidence": round(conf, 2)})

    if gestures:
        best = max(gestures, key=lambda g: g["confidence"])
        return [best]

    return []
