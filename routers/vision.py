"""Face identity management and vision endpoints."""

import logging
from typing import List

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from core.deps import get_authenticated_user
from db.models import User
from db.service import get_db_service
from db.repositories import FaceIdentityRepository, FacePhotoRepository
from models.face_recognition import get_provider as get_face_provider
from utils.images import upload_image, get_image_path, delete_image

logger = logging.getLogger(__name__)

router = APIRouter(tags=["vision"])


@router.get("/faces")
async def list_faces(user: User = Depends(get_authenticated_user)):
    """List registered face identities with photo counts."""
    def _list(session):
        repo = FaceIdentityRepository(session)
        identities = repo.list_by_user(user.id)
        return [
            {
                "id": identity.id,
                "name": identity.name,
                "photo_count": len(identity.photos),
                "created_at": identity.created_at.isoformat() + "Z",
            }
            for identity in identities
        ]

    db = get_db_service()
    return await db.execute(_list)


@router.post("/faces")
async def create_face(
    name: str,
    photo: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
):
    """Register a new face identity with an initial photo.

    The photo is processed for face detection. If no face is found, returns 400.
    """
    # Read and decode the image
    contents = await photo.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image format")

    # Detect face and compute embedding
    face_provider = get_face_provider()
    faces = face_provider.detect_and_embed(image)
    if not faces:
        raise HTTPException(status_code=400, detail="No face detected in the photo")

    # Use the face with highest detection score
    best_face = max(faces, key=lambda f: f["score"])

    # Save the photo to disk (reuse existing image storage)
    photo.file.seek(0)
    photo_uuid = upload_image(photo)

    def _create(session):
        identity_repo = FaceIdentityRepository(session)
        photo_repo = FacePhotoRepository(session)

        # If identity already exists, add photo to it; otherwise create new
        existing = identity_repo.get_by_filter(user_id=user.id, name=name)
        identity = existing if existing else identity_repo.create_identity(user.id, name)

        face_photo = photo_repo.add_photo(
            identity_id=identity.id,
            embedding=best_face["embedding"],
            photo_uuid=photo_uuid,
        )

        return {
            "id": identity.id,
            "name": identity.name,
            "photo": {
                "id": face_photo.id,
                "photo_uuid": face_photo.photo_uuid,
                "url": f"/images/{face_photo.photo_uuid}",
            },
        }

    db = get_db_service()
    return await db.execute(_create)


@router.get("/faces/{identity_id}")
async def get_face(identity_id: int, user: User = Depends(get_authenticated_user)):
    """Get face identity details with all photos."""
    def _get(session):
        repo = FaceIdentityRepository(session)
        identity = repo.get_by_user_and_id(user.id, identity_id)
        if not identity:
            raise HTTPException(status_code=404, detail="Face identity not found")

        return {
            "id": identity.id,
            "name": identity.name,
            "created_at": identity.created_at.isoformat() + "Z",
            "photos": [
                {
                    "id": p.id,
                    "photo_uuid": p.photo_uuid,
                    "url": f"/images/{p.photo_uuid}",
                    "created_at": p.created_at.isoformat() + "Z",
                }
                for p in identity.photos
            ],
        }

    db = get_db_service()
    return await db.execute(_get)


@router.delete("/faces/{identity_id}")
async def delete_face(identity_id: int, user: User = Depends(get_authenticated_user)):
    """Delete a face identity and all associated photos."""
    def _delete(session):
        repo = FaceIdentityRepository(session)
        identity = repo.get_by_user_and_id(user.id, identity_id)
        if not identity:
            raise HTTPException(status_code=404, detail="Face identity not found")

        # Collect photo UUIDs for disk cleanup
        photo_uuids = [photo.photo_uuid for photo in identity.photos]

        repo.delete(identity)
        return photo_uuids

    db = get_db_service()
    photo_uuids = await db.execute(_delete)

    # Delete photo files from disk (after DB commit)
    for uuid in photo_uuids:
        delete_image(uuid)

    return {"status": "deleted"}


@router.post("/faces/{identity_id}/photos")
async def add_face_photo(
    identity_id: int,
    photo: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
):
    """Add an additional photo to an existing face identity."""
    contents = await photo.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image format")

    face_provider = get_face_provider()
    faces = face_provider.detect_and_embed(image)
    if not faces:
        raise HTTPException(status_code=400, detail="No face detected in the photo")

    best_face = max(faces, key=lambda f: f["score"])

    photo.file.seek(0)
    photo_uuid = upload_image(photo)

    def _add_photo(session):
        identity_repo = FaceIdentityRepository(session)
        photo_repo = FacePhotoRepository(session)

        identity = identity_repo.get_by_user_and_id(user.id, identity_id)
        if not identity:
            delete_image(photo_uuid)
            raise HTTPException(status_code=404, detail="Face identity not found")

        face_photo = photo_repo.add_photo(
            identity_id=identity.id,
            embedding=best_face["embedding"],
            photo_uuid=photo_uuid,
        )

        return {
            "id": face_photo.id,
            "photo_uuid": face_photo.photo_uuid,
            "url": f"/images/{face_photo.photo_uuid}",
        }

    db = get_db_service()
    return await db.execute(_add_photo)


@router.delete("/faces/{identity_id}/photos/{photo_id}")
async def delete_face_photo(
    identity_id: int,
    photo_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Remove a specific photo from a face identity."""
    def _delete_photo(session):
        identity_repo = FaceIdentityRepository(session)
        photo_repo = FacePhotoRepository(session)

        identity = identity_repo.get_by_user_and_id(user.id, identity_id)
        if not identity:
            raise HTTPException(status_code=404, detail="Face identity not found")

        photo = photo_repo.get_by_id(photo_id)
        if not photo or photo.identity_id != identity.id:
            raise HTTPException(status_code=404, detail="Photo not found")

        photo_uuid = photo.photo_uuid
        photo_repo.delete(photo)
        return photo_uuid

    db = get_db_service()
    photo_uuid = await db.execute(_delete_photo)

    # Delete image file from disk (after DB commit)
    delete_image(photo_uuid)
    return {"status": "deleted"}


@router.get("/faces/{identity_id}/photos/{photo_id}/image")
async def get_face_photo_image(
    identity_id: int,
    photo_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Serve a face photo image file."""
    from fastapi.responses import FileResponse

    def _get_photo_uuid(session):
        identity_repo = FaceIdentityRepository(session)
        photo_repo = FacePhotoRepository(session)

        identity = identity_repo.get_by_user_and_id(user.id, identity_id)
        if not identity:
            raise HTTPException(status_code=404, detail="Face identity not found")

        photo = photo_repo.get_by_id(photo_id)
        if not photo or photo.identity_id != identity.id:
            raise HTTPException(status_code=404, detail="Photo not found")

        return photo.photo_uuid

    db = get_db_service()
    photo_uuid = await db.execute(_get_photo_uuid)

    image_path = get_image_path(photo_uuid)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image file not found")

    media_type = "image/jpeg" if image_path.suffix.lower() == ".jpg" else "image/png"
    return FileResponse(path=image_path, media_type=media_type)
