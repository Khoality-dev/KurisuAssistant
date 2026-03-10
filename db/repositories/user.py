from typing import Optional
from sqlalchemy.orm import Session

from ..models import User
from .base import BaseRepository


class UserRepository(BaseRepository[User]):
    """Repository for User model operations."""

    def __init__(self, session: Session):
        """Initialize UserRepository with session.

        Args:
            session: SQLAlchemy session instance
        """
        super().__init__(User, session)

    def get_by_username(self, username: str) -> Optional[User]:
        """Get user by username.

        Args:
            username: Username to search for

        Returns:
            User instance or None if not found
        """
        return self.get_by_filter(username=username)

    def create_user(self, username: str, password_hash: str) -> User:
        """Create a new user.

        Args:
            username: Username for the new user
            password_hash: Hashed password

        Returns:
            Created User instance

        Raises:
            ValueError: If user already exists
        """
        existing = self.get_by_username(username)
        if existing:
            raise ValueError(f"User '{username}' already exists")

        return self.create(username=username, password=password_hash)

    def update_preferences(
        self,
        user: User,
        system_prompt: Optional[str] = None,
        preferred_name: Optional[str] = None,
        ollama_url: Optional[str] = None,
        summary_model: Optional[str] = None,
        context_size: Optional[int] = None,
    ) -> User:
        """Update user preferences.

        Args:
            user: User instance to update
            system_prompt: New system prompt (optional)
            preferred_name: New preferred name (optional)
            ollama_url: Custom Ollama server URL (optional, empty string clears it)
            summary_model: Model for frame summarization (optional, empty string clears it)
            context_size: Ollama num_ctx override (optional, 0/None clears it)

        Returns:
            Updated User instance
        """
        update_data = {}
        if system_prompt is not None:
            update_data["system_prompt"] = system_prompt
        if preferred_name is not None:
            update_data["preferred_name"] = preferred_name
        if ollama_url is not None:
            # Empty string means clear the custom URL (use default)
            update_data["ollama_url"] = ollama_url if ollama_url else None
        if summary_model is not None:
            update_data["summary_model"] = summary_model if summary_model else None
        if context_size is not None:
            update_data["context_size"] = context_size if context_size else None

        if update_data:
            return self.update(user, **update_data)
        return user

    def update_avatar(
        self, user: User, avatar_uuid: Optional[str]
    ) -> User:
        """Update default agent avatar UUID.

        Args:
            user: User instance to update
            avatar_uuid: UUID of the avatar image or None to clear

        Returns:
            Updated User instance
        """
        return self.update(user, agent_avatar_uuid=avatar_uuid)

    def get_preferences(self, user: User) -> tuple[str, str]:
        """Get user preferences.

        Args:
            user: User instance

        Returns:
            Tuple of (system_prompt, preferred_name)
        """
        return user.system_prompt or "", user.preferred_name or ""

    def get_avatar(self, user: User) -> Optional[str]:
        """Get default agent avatar UUID.

        Args:
            user: User instance

        Returns:
            agent_avatar_uuid or None
        """
        return user.agent_avatar_uuid

    def admin_exists(self) -> bool:
        """Check if admin account exists.

        Returns:
            True if admin exists, False otherwise
        """
        return self.exists(username="admin")
