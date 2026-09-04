"""Skill CRUD routes."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from kurisuassistant.core.errors import internal_error
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import SkillRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/skills", tags=["skills"])


class SkillCreate(BaseModel):
    name: str
    instructions: str = ""


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    instructions: Optional[str] = None


@router.get("")
async def list_skills(
    user: User = Depends(get_authenticated_user)
):
    """List all skills for the current user."""
    try:
        def _list(session):
            repo = SkillRepository(session)
            skills = repo.list_by_user(user.id)
            return [
                {
                    "id": s.id,
                    "name": s.name,
                    "instructions": s.instructions,
                    "created_at": s.created_at.isoformat() + "Z" if s.created_at else None,
                }
                for s in skills
            ]

        db = get_db_service()
        return await db.execute(_list)
    except Exception as e:
        raise internal_error(e, "Error listing skills")


@router.post("")
async def create_skill(
    data: SkillCreate,
    user: User = Depends(get_authenticated_user)
):
    """Create a new skill."""
    try:
        def _create(session):
            repo = SkillRepository(session)
            skill = repo.create_skill(
                user_id=user.id,
                name=data.name,
                instructions=data.instructions,
            )
            return {
                "id": skill.id,
                "name": skill.name,
                "instructions": skill.instructions,
                "created_at": skill.created_at.isoformat() + "Z" if skill.created_at else None,
            }

        db = get_db_service()
        return await db.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise internal_error(e, "Error creating skill")


@router.patch("/{skill_id}")
async def update_skill(
    skill_id: int,
    data: SkillUpdate,
    user: User = Depends(get_authenticated_user)
):
    """Update a skill."""
    try:
        def _update(session):
            repo = SkillRepository(session)
            skill = repo.get_by_user_and_id(user.id, skill_id)
            if not skill:
                raise HTTPException(status_code=404, detail="Skill not found")
            skill = repo.update_skill(skill, name=data.name, instructions=data.instructions)
            return {
                "id": skill.id,
                "name": skill.name,
                "instructions": skill.instructions,
                "created_at": skill.created_at.isoformat() + "Z" if skill.created_at else None,
            }

        db = get_db_service()
        return await db.execute(_update)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error updating skill")


@router.delete("/{skill_id}")
async def delete_skill(
    skill_id: int,
    user: User = Depends(get_authenticated_user)
):
    """Delete a skill."""
    try:
        def _delete(session):
            repo = SkillRepository(session)
            deleted = repo.delete_by_user_and_id(user.id, skill_id)
            if not deleted:
                raise HTTPException(status_code=404, detail="Skill not found")
            return True

        db = get_db_service()
        await db.execute(_delete)
        return {"deleted": True}
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error deleting skill")
