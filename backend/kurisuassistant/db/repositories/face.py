"""Repositories for face recognition models."""

from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from .base import BaseRepository
from ..models import FaceIdentity, FacePhoto


class FaceIdentityRepository(BaseRepository[FaceIdentity]):
    """Repository for face identity CRUD operations."""

    def __init__(self, session: Session):
        super().__init__(FaceIdentity, session)

    def list_by_user(self, user_id: int) -> List[FaceIdentity]:
        return (
            self.session.query(FaceIdentity)
            .filter(FaceIdentity.user_id == user_id)
            .order_by(FaceIdentity.created_at.desc())
            .all()
        )

    def get_by_user_and_id(self, user_id: int, identity_id: int) -> Optional[FaceIdentity]:
        return (
            self.session.query(FaceIdentity)
            .filter(FaceIdentity.user_id == user_id, FaceIdentity.id == identity_id)
            .first()
        )

    def create_identity(self, user_id: int, name: str) -> FaceIdentity:
        return self.create(user_id=user_id, name=name)

    def delete_by_user_and_id(self, user_id: int, identity_id: int) -> bool:
        identity = self.get_by_user_and_id(user_id, identity_id)
        if identity:
            self.delete(identity)
            return True
        return False


class FacePhotoRepository(BaseRepository[FacePhoto]):
    """Repository for face photo CRUD with vector similarity search."""

    def __init__(self, session: Session):
        super().__init__(FacePhoto, session)

    def add_photo(self, identity_id: int, embedding: list, photo_uuid: str) -> FacePhoto:
        return self.create(
            identity_id=identity_id,
            embedding=embedding,
            photo_uuid=photo_uuid,
        )

    def delete_photo(self, photo_id: int) -> bool:
        photo = self.get_by_id(photo_id)
        if photo:
            self.delete(photo)
            return True
        return False

    def find_similar(
        self,
        user_id: int,
        embedding: list,
        threshold: float = 0.6,
        limit: int = 5,
    ) -> List[dict]:
        """Find similar faces using pgvector cosine distance.

        Args:
            user_id: Filter to faces registered by this user.
            embedding: Query embedding (512-dim float list).
            threshold: Maximum cosine distance (lower = more similar). 0 = identical.
            limit: Max results.

        Returns:
            List of dicts with identity_id, identity_name, photo_id, distance.
        """
        # Cosine distance: <=> operator. Range [0, 2], where 0 = identical.
        distance = FacePhoto.embedding.cosine_distance(embedding).label("distance")

        results = (
            self.session.query(
                FaceIdentity.id.label("identity_id"),
                FaceIdentity.name.label("identity_name"),
                FacePhoto.id.label("photo_id"),
                distance,
            )
            .join(FaceIdentity, FacePhoto.identity_id == FaceIdentity.id)
            .filter(FaceIdentity.user_id == user_id)
            .filter(distance < threshold)
            .order_by(distance)
            .limit(limit)
            .all()
        )

        return [
            {
                "identity_id": r.identity_id,
                "identity_name": r.identity_name,
                "photo_id": r.photo_id,
                "distance": float(r.distance),
            }
            for r in results
        ]
