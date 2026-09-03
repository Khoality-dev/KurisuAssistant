"""Image storage operations."""

import base64
import uuid
import cv2
import numpy as np
from pathlib import Path
from typing import Optional
from fastapi import HTTPException, UploadFile

# Image storage configuration - data/ directory at project root
from kurisuassistant.core.paths import DATA_DIR
IMAGES_DIR = DATA_DIR / "image_storage" / "data"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

# Per-user image storage for chat images
USER_IMAGES_DIR = IMAGES_DIR / "users"
USER_IMAGES_DIR.mkdir(parents=True, exist_ok=True)


def upload_image(file: UploadFile) -> str:
    """Save uploaded image and return UUID."""
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="File must be an image")

    # Generate UUID for the image
    image_uuid = str(uuid.uuid4())
    image_path = IMAGES_DIR / f"{image_uuid}.jpg"

    try:
        # Read and process the image
        contents = file.file.read()
        nparr = np.frombuffer(contents, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            raise HTTPException(status_code=400, detail="Invalid image format")

        # Save as JPEG with quality 90
        cv2.imwrite(str(image_path), image, [cv2.IMWRITE_JPEG_QUALITY, 90])

        return image_uuid
    except Exception as e:
        # Clean up partial file if it exists
        if image_path.exists():
            image_path.unlink()
        raise HTTPException(status_code=500, detail=f"Failed to process image: {str(e)}")


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
    """Save base64 image to per-user directory, return UUID."""
    user_dir = USER_IMAGES_DIR / str(user_id)
    user_dir.mkdir(parents=True, exist_ok=True)

    # Strip data URL prefix if present
    if "," in base64_data:
        base64_data = base64_data.split(",", 1)[1]

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
