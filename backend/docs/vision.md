# Vision Pipeline

## Architecture

Frontend (getUserMedia webcam capture) → WebSocket (base64 JPEG frames via backpressure, max 5 in-flight) → Backend (VisionProcessor runs face + gesture detection) → WebSocket (metadata results to frontend). Frontend renders webcam preview locally at native FPS via `<video>` element; backend never returns image data.

## Face Recognition

InsightFace (ArcFace, buffalo_l model, 512-dim embeddings). Lazy-loaded on first use. Models cached in `data/face_recognition/models/`.

Embeddings stored in `face_photos.embedding` (pgvector `vector(512)`) with HNSW index for cosine similarity search.

### Face Identity CRUD

REST endpoints (`/faces`, `/faces/{id}`, `/faces/{id}/photos`). Photo uploaded → face detected → embedding stored. Photos reuse existing image storage (`data/image_storage/data/`).

## Gesture Detection

Provider (`mediapipe_provider.py`) only extracts raw landmarks:
- **Body pose**: YOLOv8n-Pose on CUDA (17 COCO keypoints)
- **Hands**: MediaPipe Hands on CPU (21 landmarks/hand + handedness)

Returns `{pose_landmarks, hands: [{landmarks, handedness}]}`.

### Gesture Classification

All classification lives in `VisionProcessor`:
- **Hand gestures** (`thumbs_up`, `peace_sign`, `pointing`, `open_palm`): classified per-frame via `classify_hand_gestures()`
- **Wave**: classified from **pose trajectory** via `classify_pose_trajectory()` — wrist X oscillation across 15-frame sliding window, requiring wrist-above-shoulder + ≥2 direction reversals + minimum amplitude

Models lazy-loaded/offloaded on demand via enable flags.

## Processing

`VisionProcessor.process_frame()` decodes base64 JPEG, runs face + gesture detection sequentially in thread executor. Frame dropping via `_processing` flag (skips frame if previous inference still running). In-memory face embedding cache (numpy dot product) for ~0ms matching.

## WebSocket Events

- **Client→Server**: `VisionStartEvent` (enable_face/enable_pose/enable_hands flags), `VisionFrameEvent` (base64 JPEG), `VisionStopEvent`
- **Server→Client**: `VisionResultEvent` (faces + gestures metadata only)

## Character Animation Integration

Gestures forwarded via IPC to character window. `CanvasCompositor` evaluates `gesture` condition type on edge transitions — matching gesture triggers pose transition. One edge per directed node pair, each containing multiple `EdgeTransition` entries (condition + videos + playback rate).
