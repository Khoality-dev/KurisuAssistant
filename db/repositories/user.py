from typing import Optional, Tuple
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
    ) -> User:
        """Update user preferences.

        Args:
            user: User instance to update
            system_prompt: New system prompt (optional)
            preferred_name: New preferred name (optional)
            ollama_url: Custom Ollama server URL (optional, empty string clears it)
            summary_model: Model for frame summarization (optional, empty string clears it)

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

        if update_data:
            return self.update(user, **update_data)
        return user

    def update_avatar(
        self, user: User, avatar_type: str, avatar_uuid: Optional[str]
    ) -> User:
        """Update user avatar UUID.

        Args:
            user: User instance to update
            avatar_type: Either 'user' or 'agent'
            avatar_uuid: UUID of the avatar image or None to clear

        Returns:
            Updated User instance

        Raises:
            ValueError: If avatar_type is invalid
        """
        if avatar_type not in ("user", "agent"):
            raise ValueError("avatar_type must be 'user' or 'agent'")

        field_name = "user_avatar_uuid" if avatar_type == "user" else "agent_avatar_uuid"
        return self.update(user, **{field_name: avatar_uuid})

    def get_preferences(self, user: User) -> Tuple[str, str]:
        """Get user preferences.

        Args:
            user: User instance

        Returns:
            Tuple of (system_prompt, preferred_name)
        """
        return user.system_prompt or "", user.preferred_name or ""

    def get_avatars(self, user: User) -> Tuple[Optional[str], Optional[str]]:
        """Get user avatar UUIDs.

        Args:
            user: User instance

        Returns:
            Tuple of (user_avatar_uuid, agent_avatar_uuid)
        """
        return user.user_avatar_uuid, user.agent_avatar_uuid

    def admin_exists(self) -> bool:
        """Check if admin account exists.

        Returns:
            True if admin exists, False otherwise
        """
        return self.exists(username="admin")
