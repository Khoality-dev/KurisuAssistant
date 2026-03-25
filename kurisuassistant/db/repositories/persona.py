"""Repository for Persona model operations."""

from typing import Optional, List
from sqlalchemy.orm import Session

from ..models import Persona
from .base import BaseRepository


class PersonaRepository(BaseRepository[Persona]):
    """Repository for Persona model operations."""

    def __init__(self, session: Session):
        super().__init__(Persona, session)

    def get_by_user_and_id(self, user_id: int, persona_id: int) -> Optional[Persona]:
        return self.get_by_filter(user_id=user_id, id=persona_id)

    def get_by_user_and_name(self, user_id: int, name: str) -> Optional[Persona]:
        return self.get_by_filter(user_id=user_id, name=name)

    def list_by_user(self, user_id: int) -> List[Persona]:
        return (
            self.session.query(Persona)
            .filter_by(user_id=user_id)
            .order_by(Persona.created_at)
            .all()
        )

    def create_persona(
        self,
        user_id: int,
        name: str,
        system_prompt: str = "",
        voice_reference: Optional[str] = None,
        avatar_uuid: Optional[str] = None,
        character_config: Optional[dict] = None,
        preferred_name: Optional[str] = None,
        trigger_word: Optional[str] = None,
    ) -> Persona:
        existing = self.get_by_user_and_name(user_id, name)
        if existing:
            raise ValueError(f"Persona '{name}' already exists")

        return self.create(
            user_id=user_id,
            name=name,
            system_prompt=system_prompt,
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
            character_config=character_config,
            preferred_name=preferred_name,
            trigger_word=trigger_word,
        )

    def update_persona(
        self,
        persona: Persona,
        name: Optional[str] = None,
        system_prompt: Optional[str] = None,
        voice_reference: Optional[str] = None,
        avatar_uuid: Optional[str] = None,
        character_config: Optional[dict] = None,
        preferred_name: Optional[str] = None,
        trigger_word: Optional[str] = None,
    ) -> Persona:
        update_data = {}
        if name is not None:
            update_data["name"] = name
        if system_prompt is not None:
            update_data["system_prompt"] = system_prompt
        if voice_reference is not None:
            update_data["voice_reference"] = voice_reference
        if avatar_uuid is not None:
            update_data["avatar_uuid"] = avatar_uuid
        if character_config is not None:
            update_data["character_config"] = character_config
        if preferred_name is not None:
            update_data["preferred_name"] = preferred_name if preferred_name else None
        if trigger_word is not None:
            update_data["trigger_word"] = trigger_word

        if update_data:
            return self.update(persona, **update_data)
        return persona

    def delete_by_user_and_id(self, user_id: int, persona_id: int) -> bool:
        rows_deleted = self.delete_by_filter(user_id=user_id, id=persona_id)
        return rows_deleted > 0
