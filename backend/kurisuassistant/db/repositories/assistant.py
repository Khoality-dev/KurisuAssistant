"""Repository for Assistant model operations."""

from typing import Any, Optional
from sqlalchemy.orm import Session

from ..models import Assistant
from .base import BaseRepository, UNSET


class AssistantRepository(BaseRepository[Assistant]):
    """Repository for Assistant model operations.

    There is exactly one assistant row per user — it holds the capability half of
    the old agent (model, tools, reasoning, memory) plus the wake word. Because
    the user owns the row, it is addressed by ``user_id`` rather than by id:
    there is no list and no delete, and the row dies with its user via the FK
    cascade.
    """

    def __init__(self, session: Session):
        super().__init__(Assistant, session)

    def get_by_user(self, user_id: int) -> Optional[Assistant]:
        """Get the user's assistant.

        Args:
            user_id: User ID

        Returns:
            Assistant instance or None if the user has none yet
        """
        return self.get_by_filter(user_id=user_id)

    def create_for_user(self, user_id: int, **kwargs) -> Assistant:
        """Create the user's assistant.

        Accepts any assistant column as a keyword — ``model_name``,
        ``provider_type``, ``available_tools``, ``think``, ``use_deferred_tools``,
        ``memory``, ``memory_enabled``, ``trigger_word``, ``default_persona_id``
        — so a caller never has to create then immediately update.

        Args:
            user_id: User ID who owns the assistant
            **kwargs: Column values for the new row

        Returns:
            Created Assistant instance

        Raises:
            ValueError: If this user already has an assistant
        """
        if self.get_by_user(user_id) is not None:
            raise ValueError(f"User {user_id} already has an assistant")
        return self.create(user_id=user_id, **kwargs)

    def get_or_create_for_user(self, user_id: int, **kwargs) -> Assistant:
        """Get the user's assistant, creating it with defaults if absent.

        Args:
            user_id: User ID who owns the assistant
            **kwargs: Column values used only when the row has to be created

        Returns:
            Existing or newly created Assistant instance
        """
        assistant = self.get_by_user(user_id)
        if assistant is not None:
            return assistant
        return self.create(user_id=user_id, **kwargs)

    def update_assistant(
        self,
        assistant: Assistant,
        model_name: Any = UNSET,
        provider_type: Any = UNSET,
        available_tools: Any = UNSET,
        think: Any = UNSET,
        use_deferred_tools: Any = UNSET,
        memory: Any = UNSET,
        memory_enabled: Any = UNSET,
        trigger_word: Any = UNSET,
        default_persona_id: Any = UNSET,
    ) -> Assistant:
        """Update the assistant.

        Omitted arguments are left alone; an argument passed as ``None`` writes
        NULL. That is how the trigger word is removed, ``available_tools`` is
        reset to "every tool", or the default persona is unpinned.

        Args:
            assistant: Assistant instance to update
            **: Any column above, omitted to leave it unchanged

        Returns:
            Updated Assistant instance
        """
        return self.update_provided(
            assistant,
            model_name=model_name,
            provider_type=provider_type,
            available_tools=available_tools,
            think=think,
            use_deferred_tools=use_deferred_tools,
            memory=memory,
            memory_enabled=memory_enabled,
            trigger_word=trigger_word,
            default_persona_id=default_persona_id,
        )

    def update_memory(self, assistant: Assistant, memory: Optional[str]) -> Assistant:
        """Replace the assistant's memory document.

        Args:
            assistant: Assistant instance to update
            memory: New memory text, or None to clear it

        Returns:
            Updated Assistant instance
        """
        return self.update(assistant, memory=memory)
