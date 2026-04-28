"""Repository for Agent model operations."""

from typing import Optional, List
from sqlalchemy.orm import Session

from ..models import Agent
from .base import BaseRepository


class AgentRepository(BaseRepository[Agent]):
    """Repository for Agent model operations."""

    def __init__(self, session: Session):
        super().__init__(Agent, session)

    def get_by_user_and_id(self, user_id: int, agent_id: int) -> Optional[Agent]:
        """Get agent by user ID and agent ID.

        Args:
            user_id: User ID who owns the agent
            agent_id: Agent ID

        Returns:
            Agent instance or None if not found
        """
        return self.get_by_filter(user_id=user_id, id=agent_id)

    def get_by_user_and_name(self, user_id: int, name: str) -> Optional[Agent]:
        """Get agent by user ID and name.

        Args:
            user_id: User ID who owns the agent
            name: Agent name

        Returns:
            Agent instance or None if not found
        """
        return self.get_by_filter(user_id=user_id, name=name)

    def list_by_user(self, user_id: int) -> List[Agent]:
        """List all agents for a user.

        Args:
            user_id: User ID

        Returns:
            List of Agent instances
        """
        return (
            self.session.query(Agent)
            .filter_by(user_id=user_id)
            .order_by(Agent.created_at)
            .all()
        )

    def create_agent(
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
        agent_type: str = "main",
        voice_reference: Optional[str] = None,
        avatar_uuid: Optional[str] = None,
        character_config: Optional[dict] = None,
        preferred_name: Optional[str] = None,
        trigger_word: Optional[str] = None,
    ) -> Agent:
        """Create a new agent.

        Raises:
            ValueError: If agent with same name exists for user
        """
        existing = self.get_by_user_and_name(user_id, name)
        if existing:
            raise ValueError(f"Agent '{name}' already exists")

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
            agent_type=agent_type,
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
            character_config=character_config,
            preferred_name=preferred_name,
            trigger_word=trigger_word,
        )

    def update_agent(self, agent: Agent, **kwargs) -> Agent:
        """Update an agent. Only keys present in kwargs with non-None values are applied.

        Special case: available_tools=None is valid (means "all tools"),
        so it's always applied when the key is present in kwargs.
        """
        update_data = {}
        for k, v in kwargs.items():
            if k == "available_tools":
                update_data[k] = v  # None is a valid value (= all tools)
            elif v is not None:
                update_data[k] = v

        if update_data:
            return self.update(agent, **update_data)
        return agent

    def list_system_agents(self) -> List[Agent]:
        """List all system (built-in) agents."""
        return (
            self.session.query(Agent)
            .filter_by(is_system=True)
            .order_by(Agent.id)
            .all()
        )

    def list_enabled_for_user(self, user_id: int) -> List[Agent]:
        """List system agents + user's enabled agents."""
        from sqlalchemy import or_
        return (
            self.session.query(Agent)
            .filter(
                or_(
                    Agent.is_system == True,  # noqa: E712
                    Agent.user_id == user_id,
                ),
                Agent.enabled == True,  # noqa: E712
            )
            .order_by(Agent.id)
            .all()
        )

    def list_all_for_user(self, user_id: int) -> List[Agent]:
        """List system agents + all user's agents (regardless of enabled)."""
        from sqlalchemy import or_
        return (
            self.session.query(Agent)
            .filter(
                or_(
                    Agent.is_system == True,  # noqa: E712
                    Agent.user_id == user_id,
                ),
            )
            .order_by(Agent.id)
            .all()
        )

    def toggle_enabled(self, agent_id: int, enabled: bool) -> Optional[Agent]:
        """Toggle agent enabled state."""
        agent = self.session.query(Agent).filter_by(id=agent_id).first()
        if agent:
            agent.enabled = enabled
            self.session.commit()
        return agent

    def delete_by_user_and_id(self, user_id: int, agent_id: int) -> bool:
        """Delete an agent by user ID and agent ID.

        Args:
            user_id: User ID who owns the agent
            agent_id: Agent ID to delete

        Returns:
            True if deleted, False if not found
        """
        rows_deleted = self.delete_by_filter(user_id=user_id, id=agent_id)
        return rows_deleted > 0
