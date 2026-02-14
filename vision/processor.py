"""Background RTSP frame processor for face recognition + gesture detection.

Architecture:
- Grab thread: continuously reads RTSP, keeps only the latest frame (low latency)
- Detection loop: runs at DETECT_FPS, batches all GPU work (face + pose) in one call
- Render loop: runs at RENDER_FPS, interpolates detection results onto fresh frames
"""

import asyncio
import base64
import logging
import os
import threading
import time
from typing import Callable, Awaitable, Optional

# Force OpenCV FFmpeg backend to use TCP for RTSP (must be set before first capture)
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

import cv2
import numpy as np

import face_recognition as face_rec_module
import gesture_detection as gesture_module
from db.session import get_session

logger = logging.getLogger(__name__)

# Detection runs at this rate; render frames interpolate between keyframes
DETECT_FPS = 3
DETECT_INTERVAL = 1.0 / DETECT_FPS

# Render (debug frame) rate sent to frontend
RENDER_FPS = 15
RENDER_INTERVAL = 1.0 / RENDER_FPS

# Face matching threshold (cosine distance; lower = more similar)
FACE_MATCH_THRESHOLD = 0.6

# YOLO COCO pose skeleton connections (17 keypoints)
POSE_CONNECTIONS = [
    (5, 6), (5, 7), (7, 9), (6, 8), (8, 10),
    (5, 11), (6, 12), (11, 12),
    (11, 13), (13, 15), (12, 14), (14, 16),
]


# ---------------------------------------------------------------------------
# Interpolation helpers
# ---------------------------------------------------------------------------

def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def interpolate_faces(prev: list, curr: list, t: float) -> list:
    """Linearly interpolate face bounding boxes between two keyframes.

    Matches faces by identity_id (or index for unknowns). t in [0, 1].
    """
    if not prev:
        return curr
    if not curr:
        return prev

    # Build lookup by identity_id for known faces
    curr_by_id = {}
    curr_unknowns = []
    for f in curr:
        if f["identity_id"]:
            curr_by_id[f["identity_id"]] = f
        else:
            curr_unknowns.append(f)

    result = []
    prev_unknowns = []
    for pf in prev:
        if pf["identity_id"] and pf["identity_id"] in curr_by_id:
            cf = curr_by_id.pop(pf["identity_id"])
            pb, cb = pf["bbox"], cf["bbox"]
            result.append({
                **cf,
                "bbox": [_lerp(pb[i], cb[i], t) for i in range(4)],
            })
        elif not pf["identity_id"]:
            prev_unknowns.append(pf)
        # else: face disappeared, skip

    # Remaining current faces (new detections)
    for cf in curr_by_id.values():
        result.append(cf)

    # Match unknowns by index
    for i, cf in enumerate(curr_unknowns):
        if i < len(prev_unknowns):
            pb, cb = prev_unknowns[i]["bbox"], cf["bbox"]
            result.append({
                **cf,
                "bbox": [_lerp(pb[i2], cb[i2], t) for i2 in range(4)],
            })
        else:
            result.append(cf)

    return result


def interpolate_landmarks(prev, curr, t: float):
    """Interpolate pose landmarks (list of KeyPoint-like objects)."""
    if prev is None:
        return curr
    if curr is None:
        return prev
    if len(prev) != len(curr):
        return curr

    from gesture_detection.mediapipe_provider import KeyPoint
    result = []
    for p, c in zip(prev, curr):
        result.append(KeyPoint(
            _lerp(p.x, c.x, t),
            _lerp(p.y, c.y, t),
            max(p.visibility, c.visibility),
        ))
    return result


# ---------------------------------------------------------------------------
# Debug frame drawing
# ---------------------------------------------------------------------------

def draw_debug_frame(
    frame: np.ndarray,
    recognized_faces: list,
    gestures: list,
    pose_landmarks=None,
    hand_landmarks_list=None,
) -> str:
    """Draw bounding boxes, labels, and skeleton on frame. Returns base64 JPEG."""
    debug = frame.copy()
    h, w = debug.shape[:2]

    for face in recognized_faces:
        bbox = face["bbox"]
        x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
        name = face["name"]
        conf = face["confidence"]
        color = (0, 200, 0) if face["identity_id"] else (0, 140, 255)
        cv2.rectangle(debug, (x1, y1), (x2, y2), color, 2)
        label = f"{name} ({conf:.0%})"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
        cv2.rectangle(debug, (x1, y1 - th - 8), (x1 + tw + 4, y1), color, -1)
        cv2.putText(debug, label, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)

    if pose_landmarks:
        points = []
        for lm in pose_landmarks:
            px, py = int(lm.x * w), int(lm.y * h)
            vis = lm.visibility if hasattr(lm, 'visibility') else 1.0
            points.append((px, py, vis))
        for i, (px, py, vis) in enumerate(points):
            if vis > 0.5:
                cv2.circle(debug, (px, py), 4, (255, 200, 0), -1)
        for a, b in POSE_CONNECTIONS:
            if a < len(points) and b < len(points):
                if points[a][2] > 0.5 and points[b][2] > 0.5:
                    cv2.line(debug, (points[a][0], points[a][1]),
                             (points[b][0], points[b][1]), (255, 200, 0), 2)

    if hand_landmarks_list:
        for hand_lms in hand_landmarks_list:
            pts = [(int(lm.x * w), int(lm.y * h)) for lm in hand_lms]
            for px, py in pts:
                cv2.circle(debug, (px, py), 3, (0, 255, 200), -1)
            for finger_base in [0, 5, 9, 13, 17]:
                for i in range(finger_base, min(finger_base + 3, len(pts) - 1)):
                    cv2.line(debug, pts[i], pts[i + 1], (0, 255, 200), 1)
            for a, b in [(0, 5), (5, 9), (9, 13), (13, 17), (0, 17)]:
                if a < len(pts) and b < len(pts):
                    cv2.line(debug, pts[a], pts[b], (0, 255, 200), 1)

    if gestures:
        for i, g in enumerate(gestures):
            label = f"{g['gesture']} ({g['confidence']:.0%})"
            y_pos = 30 + i * 30
            (tw, _), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
            cv2.putText(debug, label, (w - tw - 10, y_pos),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 200, 255), 2)

    _, buf = cv2.imencode('.jpg', debug, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return base64.b64encode(buf).decode('ascii')


# ---------------------------------------------------------------------------
# Frame grabber thread
# ---------------------------------------------------------------------------

class FrameGrabber:
    """Continuously reads RTSP in a background thread, keeping only the latest frame."""

    def __init__(self, cap: cv2.VideoCapture):
        self._cap = cap
        self._frame: Optional[np.ndarray] = None
        self._lock = threading.Lock()
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while self._running:
            ret, frame = self._cap.read()
            if ret:
                with self._lock:
                    self._frame = frame
            else:
                time.sleep(0.005)

    def get_frame(self) -> Optional[np.ndarray]:
        """Get the latest frame (returns None if no frame yet)."""
        with self._lock:
            return self._frame

    def stop(self):
        self._running = False
        self._thread.join(timeout=2)


# ---------------------------------------------------------------------------
# Batched detection (single function call to minimize thread overhead)
# ---------------------------------------------------------------------------

def _batch_detect(
    frame: np.ndarray,
    face_provider,
    gesture_detector,
    enable_pose: bool,
    enable_hands: bool,
) -> dict:
    """Run all detection models on one frame. Called in a single executor thread."""
    result = {}

    # Face detection + embedding (GPU)
    if face_provider:
        result["faces_raw"] = face_provider.detect_and_embed(frame)
    else:
        result["faces_raw"] = []

    # Gesture/pose detection (YOLO GPU + MediaPipe CPU)
    if gesture_detector:
        gesture_result = gesture_detector.detect_gestures(
            frame, enable_pose=enable_pose, enable_hands=enable_hands
        )
        result["gestures"] = gesture_result.get("gestures", [])
        result["pose_landmarks"] = gesture_result.get("pose_landmarks") if enable_pose else None
        result["hand_landmarks"] = gesture_result.get("hand_landmarks") if enable_hands else None
    else:
        result["gestures"] = []
        result["pose_landmarks"] = None
        result["hand_landmarks"] = None

    return result


# ---------------------------------------------------------------------------
# Vision processor
# ---------------------------------------------------------------------------

class VisionProcessor:
    """Background RTSP frame processor with separate detect/render loops."""

    def __init__(self, rtsp_url: str, user_id: int, *,
                 enable_face: bool = True,
                 enable_pose: bool = True,
                 enable_hands: bool = True):
        self.rtsp_url = rtsp_url
        self.user_id = user_id
        self.enable_face = enable_face
        self.enable_pose = enable_pose
        self.enable_hands = enable_hands
        self.running = False
        self._cap: Optional[cv2.VideoCapture] = None
        self._grabber: Optional[FrameGrabber] = None
        self._embedding_cache: Optional[list] = None

    @staticmethod
    def _try_open_rtsp(url: str) -> Optional[cv2.VideoCapture]:
        cap = cv2.VideoCapture()
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.open(url, cv2.CAP_FFMPEG)
        return cap

    async def start(self, result_callback: Callable[[dict], Awaitable[None]]):
        self.running = True
        face_provider = face_rec_module.get_provider() if self.enable_face else None
        gesture_detector = gesture_module.get_provider() if (self.enable_pose or self.enable_hands) else None

        # Connect to RTSP with retries
        loop = asyncio.get_event_loop()
        max_retries = 30
        for attempt in range(max_retries):
            if not self.running:
                return
            logger.debug("RTSP connecting (%d/%d): %s", attempt + 1, max_retries, self.rtsp_url)
            self._cap = await loop.run_in_executor(None, self._try_open_rtsp, self.rtsp_url)
            if self._cap is not None and self._cap.isOpened():
                break
            if self._cap is not None:
                self._cap.release()
            self._cap = None
            await asyncio.sleep(2.0)

        if self._cap is None or not self._cap.isOpened():
            logger.error("Failed to open RTSP stream after %d retries: %s", max_retries, self.rtsp_url)
            self.running = False
            return

        logger.info("Vision processor started for user %d, RTSP: %s", self.user_id, self.rtsp_url)

        # Start background frame grabber
        self._grabber = FrameGrabber(self._cap)

        # Detection keyframes: [prev, curr]
        kf_prev = None  # {time, faces, gestures, pose_landmarks, hand_landmarks}
        kf_curr = None

        try:
            detect_task = asyncio.create_task(
                self._detection_loop(loop, face_provider, gesture_detector, result_callback)
            )
            await detect_task
        except asyncio.CancelledError:
            logger.debug("Vision processor task cancelled")
        except Exception as e:
            logger.error("Vision processor error: %s", e, exc_info=True)
        finally:
            self.stop()

    async def _detection_loop(self, loop, face_provider, gesture_detector, result_callback):
        """Combined detect + render loop.

        Every DETECT_INTERVAL: grab latest frame, run batched detection, store keyframe.
        Every RENDER_INTERVAL: grab latest frame, interpolate, draw, send.
        """
        import functools

        # Keyframe state
        kf_prev = None
        kf_curr = None
        last_detect_time = 0.0

        while self.running:
            t_now = time.perf_counter()
            frame = self._grabber.get_frame()
            if frame is None:
                await asyncio.sleep(0.01)
                continue

            # --- Detection keyframe ---
            if t_now - last_detect_time >= DETECT_INTERVAL:
                t_det = time.perf_counter()

                detect_result = await loop.run_in_executor(
                    None,
                    functools.partial(
                        _batch_detect, frame,
                        face_provider, gesture_detector,
                        self.enable_pose, self.enable_hands,
                    ),
                )

                # Match faces
                faces_raw = detect_result["faces_raw"]
                if face_provider and faces_raw:
                    recognized = self._match_faces(faces_raw)
                else:
                    recognized = []

                dt_det = time.perf_counter() - t_det
                logger.info("DETECT %.0fms (%.1f det-FPS)", dt_det * 1000, 1.0 / dt_det if dt_det > 0 else 0)

                # Shift keyframes
                kf_prev = kf_curr
                kf_curr = {
                    "time": t_now,
                    "faces": recognized,
                    "gestures": detect_result["gestures"],
                    "pose_landmarks": detect_result["pose_landmarks"],
                    "hand_landmarks": detect_result["hand_landmarks"],
                }
                last_detect_time = t_now

            # --- Render frame with interpolation ---
            if kf_curr is None:
                await asyncio.sleep(0.01)
                continue

            # Compute interpolation factor
            if kf_prev and kf_curr["time"] > kf_prev["time"]:
                elapsed = t_now - kf_prev["time"]
                span = kf_curr["time"] - kf_prev["time"]
                t = min(elapsed / span, 1.0)
            else:
                t = 1.0

            # Interpolate
            if t < 1.0 and kf_prev:
                faces_interp = interpolate_faces(kf_prev["faces"], kf_curr["faces"], t)
                pose_interp = interpolate_landmarks(
                    kf_prev["pose_landmarks"], kf_curr["pose_landmarks"], t
                )
            else:
                faces_interp = kf_curr["faces"]
                pose_interp = kf_curr["pose_landmarks"]

            # Draw debug overlay on fresh frame
            debug_frame = await loop.run_in_executor(
                None, draw_debug_frame, frame,
                faces_interp, kf_curr["gestures"],
                pose_interp, kf_curr["hand_landmarks"],
            )

            await result_callback({
                "faces": kf_curr["faces"],
                "gestures": kf_curr["gestures"],
                "debug_frame": debug_frame,
            })

            await asyncio.sleep(RENDER_INTERVAL)

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

    def stop(self):
        self.running = False
        if self._grabber:
            self._grabber.stop()
            self._grabber = None
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        logger.info("Vision processor stopped for user %d", self.user_id)
