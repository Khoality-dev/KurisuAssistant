"""Image operations via image-storage service."""

import os
import requests
from typing import Optional
from fastapi import HTTPException, UploadFile

IMAGE_SERVICE_URL = os.getenv("IMAGE_SERVICE_URL", "http://localhost:15599")


def upload_image(file: UploadFile) -> str:
    """Upload image to image-storage service and return UUID."""
    files = {"file": (file.filename, file.file, file.content_type)}
    response = requests.post(f"{IMAGE_SERVICE_URL}/images", files=files)
    
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, 
                          detail=f"Image upload failed: {response.text}")
    
    result = response.json()
    return result["image_uuid"]


def check_image_exists(image_uuid: str) -> bool:
    """Check if an image exists in image-storage service."""
    try:
        response = requests.get(f"{IMAGE_SERVICE_URL}/images/{image_uuid}/exists")
        
        if response.status_code != 200:
            return False
        
        result = response.json()
        return result.get("exists", False)
    except requests.RequestException:
        return False


def delete_image(image_uuid: str) -> bool:
    """Delete an image from image-storage service."""
    try:
        response = requests.delete(f"{IMAGE_SERVICE_URL}/images/{image_uuid}")
        
        if response.status_code == 404:
            return False
        elif response.status_code != 200:
            raise HTTPException(status_code=response.status_code,
                              detail=f"Image deletion failed: {response.text}")
        
        return True
    except requests.RequestException as e:
        raise HTTPException(status_code=500, detail=f"Image service error: {str(e)}")


def get_image_url(image_uuid: str) -> str:
    """Get the URL for accessing an image."""
    return f"/images/{image_uuid}"