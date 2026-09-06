# Vision Pipeline

**Runs without a GPU, slower.** YOLOv8-Pose used to be sent to `device="cuda"`
unconditionally, so on the CPU-only default stack camera vision failed at the
point of use (#152). `resolve_device()` in
`models/gesture_detection/mediapipe_provider.py` now picks the device once per
process: `VISION_DEVICE` if set (`cpu`, `cuda`, `cuda:1`), otherwise `cuda` when
torch can see a GPU and `cpu` when it cannot, and logs the choice at startup of
the detector — so "why is gesture detection slow" (`device: cpu`) and "why does
it not work" read differently in the log. Forcing `cuda` on a host without one
falls back to the CPU with a warning rather than failing per frame. Reserving a
GPU for the `api` service is a `docker-compose.override.yml` matter (see
`development.md`), because a device reservation in the base file makes `up`
fail outright on a host without the NVIDIA runtime.

## Architecture

Frontend (getUserMedia webcam capture) → WebSocket **binary** frames (JPEG bytes behind a 4-byte header, backpressure-limited in-flight) → Backend (VisionProcessor runs face + gesture detection) → WebSocket (metadata results to frontend, as JSON). Frontend renders webcam preview locally at native FPS via `<video>` element; backend never returns image data.

## Face Recognition

InsightFace (ArcFace, buffalo_l model, 512-dim embeddings). Lazy-loaded on first use. Models cached in `data/face_recognition/models/`.

Embeddings stored in `face_photos.embedding` (pgvector `vector(512)`) with HNSW index for cosine similarity search.

### Face Identity CRUD

REST endpoints (`/faces`, `/faces/{id}`, `/faces/{id}/photos`). Photo uploaded → face detected → embedding stored. Photos reuse existing image storage (`data/image_storage/data/`).

## Gesture Detection

Provider (`mediapipe_provider.py`) only extracts raw landmarks:
- **Body pose**: YOLOv8n-Pose on the resolved device — CUDA or CPU (17 COCO keypoints)
- **Hands**: MediaPipe Hands on CPU (21 landmarks/hand + handedness)

Returns `{pose_landmarks, hands: [{landmarks, handedness}]}`.

### Gesture Classification

All classification lives in `VisionProcessor`:
- **Hand gestures** (`thumbs_up`, `peace_sign`, `pointing`, `open_palm`): classified per-frame via `classify_hand_gestures()`
- **Wave**: classified from **pose trajectory** via `classify_pose_trajectory()` — wrist X oscillation across 15-frame sliding window, requiring wrist-above-shoulder + ≥2 direction reversals + minimum amplitude

Models lazy-loaded/offloaded on demand via enable flags.

## Transport

Frames travel as WebSocket binary messages so they never share the JSON path with
chat. `websocket/binary.py` parses the envelope; a malformed or over-long message
answers `error` with `BAD_BINARY_MESSAGE` and leaves the socket open, because a
bad frame from a camera is not a reason to drop a conversation. The cap is 4 MiB
per message and 4 KiB of header.

## Processing

`VisionProcessor.process_frame()` takes raw JPEG bytes, runs face + gesture detection sequentially in thread executor. Frame dropping via `_processing` flag (skips frame if previous inference still running). In-memory face embedding cache (numpy dot product) for ~0ms matching.

## WebSocket Events

- **Client→Server**: `VisionStartEvent` and `VisionStopEvent` are JSON events. A **frame is a binary message**, not JSON — `[version][type][header length][JSON header][JPEG]`, see [websocket.md](websocket.md#vision) and `websocket/binary.py`. It was base64 inside JSON until protocol 6: a third more bytes, a JSON parse per frame, and the pixels queued ahead of the assistant's next token on the same socket (#111)
- **Server→Client**: `VisionResultEvent` (faces + gestures metadata only)

## Character Animation Integration

Gestures forwarded via IPC to character window. `CanvasCompositor` evaluates `gesture` condition type on edge transitions — matching gesture triggers pose transition. One edge per directed node pair, each containing multiple `EdgeTransition` entries (condition + videos + playback rate).
