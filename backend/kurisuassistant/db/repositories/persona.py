"""Repository for Persona model operations."""

from typing import Any, Optional, List
from sqlalchemy.orm import Session

from ..models import Persona
from .base import BaseRepository, UNSET


class PersonaRepository(BaseRepository[Persona]):
    """Repository for Persona model operations.

    A persona is presentation only — name, prompt, voice, avatar. Model, tools
    and memory live on the user's single :class:`~..models.Assistant`, so nothing
    here touches capability.
    """

    def __init__(self, session: Session):
        super().__init__(Persona, session)

    def get_by_user_and_id(self, user_id: int, persona_id: int) -> Optional[Persona]:
        """Get persona by user ID and persona ID.

        Args:
            user_id: User ID who owns the persona
            persona_id: Persona ID

        Returns:
            Persona instance or None if not found
        """
        return self.get_by_filter(user_id=user_id, id=persona_id)

    def get_by_user_and_name(self, user_id: int, name: str) -> Optional[Persona]:
        """Get persona by user ID and name.

        Args:
            user_id: User ID who owns the persona
            name: Persona name

        Returns:
            Persona instance or None if not found
        """
        return self.get_by_filter(user_id=user_id, name=name)

    def list_by_user(self, user_id: int) -> List[Persona]:
        """List all personas for a user, enabled or not.

        Args:
            user_id: User ID

        Returns:
            List of Persona instances, oldest first
        """
        return (
            self.session.query(Persona)
            .filter_by(user_id=user_id)
            .order_by(Persona.created_at)
            .all()
        )

    def list_enabled_by_user(self, user_id: int) -> List[Persona]:
        """List a user's enabled personas — the ones eligible to answer.

        Args:
            user_id: User ID

        Returns:
            List of Persona instances, oldest first
        """
        return (
            self.session.query(Persona)
            .filter_by(user_id=user_id, enabled=True)
            .order_by(Persona.created_at)
            .all()
        )

    def create_persona(
        self,
        user_id: int,
        name: str,
        description: str = "",
        system_prompt: str = "",
        voice_reference: Optional[str] = None,
        avatar_uuid: Optional[str] = None,
        character_config: Optional[dict] = None,
        preferred_name: Optional[str] = None,
        enabled: bool = True,
    ) -> Persona:
        """Create a new persona.

        Every column a caller may legitimately set is accepted here, so importing
        a persona is a single create rather than a create-then-update.

        Raises:
            ValueError: If a persona with the same name exists for this user
        """
        existing = self.get_by_user_and_name(user_id, name)
        if existing:
            raise ValueError(f"Persona '{name}' already exists")

        return self.create(
            user_id=user_id,
            name=name,
            description=description,
            system_prompt=system_prompt,
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
            character_config=character_config,
            preferred_name=preferred_name,
            enabled=enabled,
        )

    def update_persona(
        self,
        persona: Persona,
        name: Any = UNSET,
        description: Any = UNSET,
        system_prompt: Any = UNSET,
        voice_reference: Any = UNSET,
        avatar_uuid: Any = UNSET,
        character_config: Any = UNSET,
        preferred_name: Any = UNSET,
        enabled: Any = UNSET,
    ) -> Persona:
        """Update a persona.

        Omitted arguments are left alone; an argument passed as ``None`` writes
        NULL. That is how a voice reference, avatar or preferred name gets
        cleared.

        Args:
            persona: Persona instance to update
            **: Any column above, omitted to leave it unchanged

        Returns:
            Updated Persona instance
        """
        return self.update_provided(
            persona,
            name=name,
            description=description,
            system_prompt=system_prompt,
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
            character_config=character_config,
            preferred_name=preferred_name,
            enabled=enabled,
        )

    def set_enabled(
        self, user_id: int, persona_id: int, enabled: bool
    ) -> Optional[Persona]:
        """Set a persona's enabled state, scoped to its owner.

        Args:
            user_id: User ID who owns the persona
            persona_id: Persona ID
            enabled: New enabled state

        Returns:
            Updated Persona instance or None if not found for this user
        """
        persona = self.get_by_user_and_id(user_id, persona_id)
        if persona is None:
            return None
        return self.update(persona, enabled=enabled)

    def delete_by_user_and_id(self, user_id: int, persona_id: int) -> bool:
        """Delete a persona by user ID and persona ID.

        Args:
            user_id: User ID who owns the persona
            persona_id: Persona ID to delete

        Returns:
            True if deleted, False if not found
        """
        return self.delete_by_filter(user_id=user_id, id=persona_id) > 0
