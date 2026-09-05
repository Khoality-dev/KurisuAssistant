"""Repository for SubAgent model operations."""

from typing import Any, Optional, List
from sqlalchemy.orm import Session

from ..models import SubAgent
from .base import BaseRepository, UNSET


class SubAgentRepository(BaseRepository[SubAgent]):
    """Repository for SubAgent model operations.

    A sub-agent is a task-only worker: it has its own model and tools because it
    runs its own LLM loop, but no identity and no memory. It is never bound to a
    conversation, so nothing here mirrors the persona binding helpers.
    """

    def __init__(self, session: Session):
        super().__init__(SubAgent, session)

    def get_by_user_and_id(self, user_id: int, sub_agent_id: int) -> Optional[SubAgent]:
        """Get sub-agent by user ID and sub-agent ID.

        Args:
            user_id: User ID who owns the sub-agent
            sub_agent_id: Sub-agent ID

        Returns:
            SubAgent instance or None if not found
        """
        return self.get_by_filter(user_id=user_id, id=sub_agent_id)

    def get_by_user_and_name(self, user_id: int, name: str) -> Optional[SubAgent]:
        """Get sub-agent by user ID and name.

        Args:
            user_id: User ID who owns the sub-agent
            name: Sub-agent name

        Returns:
            SubAgent instance or None if not found
        """
        return self.get_by_filter(user_id=user_id, name=name)

    def list_by_user(self, user_id: int) -> List[SubAgent]:
        """List all sub-agents for a user, enabled or not.

        Args:
            user_id: User ID

        Returns:
            List of SubAgent instances, oldest first
        """
        return (
            self.session.query(SubAgent)
            .filter_by(user_id=user_id)
            .order_by(SubAgent.created_at)
            .all()
        )

    def list_enabled_by_user(self, user_id: int) -> List[SubAgent]:
        """List a user's enabled sub-agents — the ones exposed to the assistant.

        Args:
            user_id: User ID

        Returns:
            List of SubAgent instances, oldest first
        """
        return (
            self.session.query(SubAgent)
            .filter_by(user_id=user_id, enabled=True)
            .order_by(SubAgent.created_at)
            .all()
        )

    def create_sub_agent(
        self,
        user_id: int,
        name: str,
        description: str = "",
        system_prompt: str = "",
        model_name: Optional[str] = None,
        provider_type: str = "ollama",
        available_tools: Optional[List[str]] = None,
        think: bool = False,
        use_deferred_tools: bool = False,
        enabled: bool = True,
    ) -> SubAgent:
        """Create a new sub-agent.

        Every column a caller may legitimately set is accepted here, so importing
        a sub-agent is a single create rather than a create-then-update.

        Raises:
            ValueError: If a sub-agent with the same name exists for this user
        """
        existing = self.get_by_user_and_name(user_id, name)
        if existing:
            raise ValueError(f"Sub-agent '{name}' already exists")

        return self.create(
            user_id=user_id,
            name=name,
            description=description,
            system_prompt=system_prompt,
            model_name=model_name,
            provider_type=provider_type,
            available_tools=available_tools,
            think=think,
            use_deferred_tools=use_deferred_tools,
            enabled=enabled,
        )

    def update_sub_agent(
        self,
        sub_agent: SubAgent,
        name: Any = UNSET,
        description: Any = UNSET,
        system_prompt: Any = UNSET,
        model_name: Any = UNSET,
        provider_type: Any = UNSET,
        available_tools: Any = UNSET,
        think: Any = UNSET,
        use_deferred_tools: Any = UNSET,
        enabled: Any = UNSET,
    ) -> SubAgent:
        """Update a sub-agent.

        Omitted arguments are left alone; an argument passed as ``None`` writes
        NULL. That is how ``model_name`` falls back to the default, or
        ``available_tools`` is reset to "every tool".

        Args:
            sub_agent: SubAgent instance to update
            **: Any column above, omitted to leave it unchanged

        Returns:
            Updated SubAgent instance
        """
        return self.update_provided(
            sub_agent,
            name=name,
            description=description,
            system_prompt=system_prompt,
            model_name=model_name,
            provider_type=provider_type,
            available_tools=available_tools,
            think=think,
            use_deferred_tools=use_deferred_tools,
            enabled=enabled,
        )

    def set_enabled(
        self, user_id: int, sub_agent_id: int, enabled: bool
    ) -> Optional[SubAgent]:
        """Set a sub-agent's enabled state, scoped to its owner.

        Args:
            user_id: User ID who owns the sub-agent
            sub_agent_id: Sub-agent ID
            enabled: New enabled state

        Returns:
            Updated SubAgent instance or None if not found for this user
        """
        sub_agent = self.get_by_user_and_id(user_id, sub_agent_id)
        if sub_agent is None:
            return None
        return self.update(sub_agent, enabled=enabled)

    def delete_by_user_and_id(self, user_id: int, sub_agent_id: int) -> bool:
        """Delete a sub-agent by user ID and sub-agent ID.

        Args:
            user_id: User ID who owns the sub-agent
            sub_agent_id: Sub-agent ID to delete

        Returns:
            True if deleted, False if not found
        """
        return self.delete_by_filter(user_id=user_id, id=sub_agent_id) > 0
