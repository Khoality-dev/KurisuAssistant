"""Repository for Skill model operations."""

from typing import Optional, List
from sqlalchemy.orm import Session

from ..models import Skill
from .base import BaseRepository


class SkillRepository(BaseRepository[Skill]):
    """Repository for Skill model operations."""

    def __init__(self, session: Session):
        super().__init__(Skill, session)

    def list_by_user(self, user_id: int) -> List[Skill]:
        return (
            self.session.query(Skill)
            .filter_by(user_id=user_id)
            .order_by(Skill.created_at)
            .all()
        )

    def get_by_user_and_id(self, user_id: int, skill_id: int) -> Optional[Skill]:
        return self.get_by_filter(user_id=user_id, id=skill_id)

    def create_skill(self, user_id: int, name: str, instructions: str = "") -> Skill:
        existing = self.get_by_filter(user_id=user_id, name=name)
        if existing:
            raise ValueError(f"Skill '{name}' already exists")
        return self.create(user_id=user_id, name=name, instructions=instructions)

    def update_skill(self, skill: Skill, name: Optional[str] = None, instructions: Optional[str] = None) -> Skill:
        update_data = {}
        if name is not None:
            update_data["name"] = name
        if instructions is not None:
            update_data["instructions"] = instructions
        if update_data:
            return self.update(skill, **update_data)
        return skill

    def delete_by_user_and_id(self, user_id: int, skill_id: int) -> bool:
        return self.delete_by_filter(user_id=user_id, id=skill_id) > 0
