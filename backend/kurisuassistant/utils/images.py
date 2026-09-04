"""Image storage operations."""

import base64
import os
import uuid
import cv2
import numpy as np
from pathlib import Path
from typing import Optional
from fastapi import HTTPException, UploadFile

from kurisuassistant.core.errors import internal_error

# Image storage configuration - data/ directory at project root
from kurisuassistant.core.paths import DATA_DIR
IMAGES_DIR = DATA_DIR / "image_storage" / "data"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

# Per-user image storage for chat images
USER_IMAGES_DIR = IMAGES_DIR / "users"
USER_IMAGES_DIR.mkdir(parents=True, exist_ok=True)


# An upload is read into memory whole and then decoded, which allocates the
# bitmap on top, so the ceiling has to be well under available memory.
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(16 * 1024 * 1024)))


def _read_bounded(stream, limit: int = MAX_IMAGE_BYTES) -> bytes:
    """Read at most ``limit`` bytes, refusing anything larger.

    Reads one byte past the limit so an oversized upload is rejected rather
    than silently truncated into a corrupt image.
    """
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"Image is larger than the {limit // (1024 * 1024)} MB limit.",
        )
    return data


def upload_image(file: UploadFile) -> str:
    """Save an uploaded image and return its UUID.

    The declared content type is not trusted: it is client-supplied and gates
    nothing, since whether this is really an image is settled by the decode
    below. It was also assumed non-null, so a request without the header raised
    an AttributeError and surfaced as a 500.
    """
    image_uuid = str(uuid.uuid4())
    image_path = IMAGES_DIR / f"{image_uuid}.jpg"

    try:
        contents = _read_bounded(file.file)
        nparr = np.frombuffer(contents, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            raise HTTPException(status_code=400, detail="That file could not be read as an image.")

        # Save as JPEG with quality 90
        cv2.imwrite(str(image_path), image, [cv2.IMWRITE_JPEG_QUALITY, 90])

        return image_uuid
    except HTTPException:
        if image_path.exists():
            image_path.unlink()
        raise
    except Exception as e:
        if image_path.exists():
            image_path.unlink()
        # The decoder's message can name a server path, so it is logged instead.
        raise internal_error(e, "processing an uploaded image")


def check_image_exists(image_uuid: str) -> bool:
    """Check if an image exists by UUID."""
    try:
        uuid.UUID(image_uuid)  # Validate UUID format
    except ValueError:
        return False

    # Check for JPG first, then PNG (backward compatibility)
    jpg_path = IMAGES_DIR / f"{image_uuid}.jpg"
    png_path = IMAGES_DIR / f"{image_uuid}.png"

    return jpg_path.exists() or png_path.exists()


def get_image_path(image_uuid: str) -> Optional[Path]:
    """Get the path to an image file by UUID."""
    try:
        uuid.UUID(image_uuid)  # Validate UUID format
    except ValueError:
        return None

    # Check for JPG first, then PNG (backward compatibility)
    jpg_path = IMAGES_DIR / f"{image_uuid}.jpg"
    if jpg_path.exists():
        return jpg_path

    png_path = IMAGES_DIR / f"{image_uuid}.png"
    if png_path.exists():
        return png_path

    return None


def delete_image(image_uuid: str) -> bool:
    """Delete an image by UUID."""
    image_path = get_image_path(image_uuid)
    if image_path and image_path.exists():
        image_path.unlink()
        return True
    return False


def save_image_from_array(image: np.ndarray) -> str:
    """Save a BGR numpy array as JPEG and return UUID."""
    image_uuid = str(uuid.uuid4())
    image_path = IMAGES_DIR / f"{image_uuid}.jpg"
    cv2.imwrite(str(image_path), image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return image_uuid


def get_image_url(image_uuid: str) -> str:
    """Get the URL for accessing an image."""
    return f"/images/{image_uuid}"


def save_image_from_base64(base64_data: str, user_id: int) -> str:
    """Save a base64 image to the user's directory and return its UUID.

    These arrive over the WebSocket, so the same ceiling applies. base64 is
    roughly four bytes per three, so the encoded form is checked against the
    correspondingly larger bound before it is decoded.
    """
    user_dir = USER_IMAGES_DIR / str(user_id)
    user_dir.mkdir(parents=True, exist_ok=True)

    # Strip data URL prefix if present
    if "," in base64_data:
        base64_data = base64_data.split(",", 1)[1]

    if len(base64_data) > (MAX_IMAGE_BYTES * 4) // 3 + 4:
        raise ValueError("Image exceeds the maximum allowed size")

    image_bytes = base64.b64decode(base64_data)
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Invalid image data")

    image_uuid = str(uuid.uuid4())
    cv2.imwrite(str(user_dir / f"{image_uuid}.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return image_uuid


def get_user_image_path(user_id: int, image_uuid: str) -> Optional[Path]:
    """Get path to a user-scoped image."""
    try:
        uuid.UUID(image_uuid)
    except ValueError:
        return None

    path = USER_IMAGES_DIR / str(user_id) / f"{image_uuid}.jpg"
    return path if path.exists() else None
