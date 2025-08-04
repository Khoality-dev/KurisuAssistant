"""Image storage and management service."""

import uuid
import uvicorn
from pathlib import Path
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

app = FastAPI(title="Image Storage Service", description="Internal image storage and management service")

# Image storage configuration
IMAGES_DIR = Path("/app/data")
IMAGES_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


@app.post("/images")
async def upload_image(file: UploadFile = File(...)):
    """Upload image and return UUID."""
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="File must be an image")
    
    # Generate UUID for the image
    image_uuid = str(uuid.uuid4())
    image_path = IMAGES_DIR / f"{image_uuid}.jpg"
    
    try:
        # Read and process the image
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if image is None:
            raise HTTPException(status_code=400, detail="Invalid image format")
        
        # Save as JPEG with quality 90
        cv2.imwrite(str(image_path), image, [cv2.IMWRITE_JPEG_QUALITY, 90])
        
        return {"image_uuid": image_uuid, "url": f"/images/{image_uuid}"}
    except Exception as e:
        # Clean up partial file if it exists
        if image_path.exists():
            image_path.unlink()
        raise HTTPException(status_code=500, detail=f"Failed to process image: {str(e)}")


@app.get("/images/{image_uuid}")
async def get_image(image_uuid: str):
    """Serve image by UUID."""
    # Validate UUID format
    try:
        uuid.UUID(image_uuid)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image UUID format")
    
    # Check for JPG first, then PNG (backward compatibility)
    jpg_path = IMAGES_DIR / f"{image_uuid}.jpg"
    if jpg_path.exists():
        return FileResponse(jpg_path, media_type="image/jpeg")
    
    png_path = IMAGES_DIR / f"{image_uuid}.png"
    if png_path.exists():
        return FileResponse(png_path, media_type="image/png")
    
    raise HTTPException(status_code=404, detail="Image not found")


@app.get("/images/{image_uuid}/exists")
async def check_image_exists(image_uuid: str):
    """Check if an image exists by UUID."""
    # Validate UUID format
    try:
        uuid.UUID(image_uuid)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image UUID format")
    
    # Check if image exists
    jpg_path = IMAGES_DIR / f"{image_uuid}.jpg"
    png_path = IMAGES_DIR / f"{image_uuid}.png"
    
    exists = jpg_path.exists() or png_path.exists()
    return {"exists": exists, "image_uuid": image_uuid}


@app.delete("/images/{image_uuid}")
async def delete_image(image_uuid: str):
    """Delete an image by UUID."""
    # Validate UUID format
    try:
        uuid.UUID(image_uuid)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image UUID format")
    
    # Try to delete both JPG and PNG versions
    jpg_path = IMAGES_DIR / f"{image_uuid}.jpg"
    png_path = IMAGES_DIR / f"{image_uuid}.png"
    
    deleted = False
    if jpg_path.exists():
        jpg_path.unlink()
        deleted = True
    if png_path.exists():
        png_path.unlink()
        deleted = True
    
    if not deleted:
        raise HTTPException(status_code=404, detail="Image not found")
    
    return {"status": "deleted", "image_uuid": image_uuid}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=15599)