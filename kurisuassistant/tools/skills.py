"""Skill tools — on-demand skill lookup and system prompt helpers."""

import logging
from typing import Dict, Any, List

from .base import BaseTool

logger = logging.getLogger(__name__)


def get_skill_names_for_user(user_id: int) -> List[str]:
    """Load all skill names for a user."""
    from kurisuassistant.db.service import get_db_service
    from kurisuassistant.db.repositories import SkillRepository

    try:
        db = get_db_service()
        return db.execute_sync(lambda s: [
            skill.name for skill in SkillRepository(s).list_by_user(user_id)
            if skill.name
        ])
    except Exception as e:
        logger.error(f"Failed to load skill names for user {user_id}: {e}", exc_info=True)
        return []


class GetSkillInstructionsTool(BaseTool):
    """Look up the full instructions for a skill by name."""

    name = "get_skill_instructions"
    description = (
        "Get the full instructions for a skill by name. "
        "Call this before performing a task when a relevant skill is listed in the system prompt."
    )
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "The name of the skill to look up.",
                        },
                    },
                    "required": ["name"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.db.repositories import SkillRepository

        skill_name = args.get("name", "")
        user_id = args.get("user_id")

        if not skill_name:
            return "Error: skill name is required."
        if not user_id:
            return "Error: no user context available."

        try:
            def _get_skill(session):
                repo = SkillRepository(session)
                skill = repo.get_by_filter(user_id=user_id, name=skill_name)
                if not skill:
                    return f"Skill '{skill_name}' not found."
                return skill.instructions or "(no instructions)"

            db = get_db_service()
            return await db.execute(_get_skill)
        except Exception as e:
            logger.error(f"Failed to get skill '{skill_name}': {e}", exc_info=True)
            return f"Error looking up skill: {e}"
