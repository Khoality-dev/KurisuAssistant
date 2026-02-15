"""Skill CRUD routes."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import SkillRepository

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
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """List all skills for the current user."""
    try:
        with get_session() as session:
            repo = SkillRepository(session)
            skills = repo.list_by_user(user.id)
            return [
                {
                    "id": s.id,
                    "name": s.name,
                    "instructions": s.instructions,
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                }
                for s in skills
            ]
    except Exception as e:
        logger.error(f"Error listing skills: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("")
async def create_skill(
    data: SkillCreate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Create a new skill."""
    try:
        with get_session() as session:
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
                "created_at": skill.created_at.isoformat() if skill.created_at else None,
            }
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating skill: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{skill_id}")
async def update_skill(
    skill_id: int,
    data: SkillUpdate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Update a skill."""
    try:
        with get_session() as session:
            repo = SkillRepository(session)
            skill = repo.get_by_user_and_id(user.id, skill_id)
            if not skill:
                raise HTTPException(status_code=404, detail="Skill not found")

            skill = repo.update_skill(skill, name=data.name, instructions=data.instructions)
            return {
                "id": skill.id,
                "name": skill.name,
                "instructions": skill.instructions,
                "created_at": skill.created_at.isoformat() if skill.created_at else None,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating skill: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{skill_id}")
async def delete_skill(
    skill_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete a skill."""
    try:
        with get_session() as session:
            repo = SkillRepository(session)
            deleted = repo.delete_by_user_and_id(user.id, skill_id)
            if not deleted:
                raise HTTPException(status_code=404, detail="Skill not found")
            return {"deleted": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting skill: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
