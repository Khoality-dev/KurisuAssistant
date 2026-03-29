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
        system_prompt: str = "",
        model_name: Optional[str] = None,
        provider_type: str = "ollama",
        available_tools: Optional[List[str]] = None,
        think: bool = False,
        persona_id: Optional[int] = None,
        use_deferred_tools: bool = False,
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
            system_prompt=system_prompt,
            model_name=model_name,
            provider_type=provider_type,
            available_tools=available_tools,
            think=think,
            persona_id=persona_id,
            use_deferred_tools=use_deferred_tools,
        )

    def update_agent(
        self,
        agent: Agent,
        name: Optional[str] = None,
        system_prompt: Optional[str] = None,
        model_name: Optional[str] = None,
        provider_type: Optional[str] = None,
        available_tools: Optional[List[str]] = None,
        think: Optional[bool] = None,
        memory: Optional[str] = None,
        memory_enabled: Optional[bool] = None,
        persona_id: Optional[int] = None,
        use_deferred_tools: Optional[bool] = None,
    ) -> Agent:
        """Update an agent."""
        update_data = {}
        if name is not None:
            update_data["name"] = name
        if system_prompt is not None:
            update_data["system_prompt"] = system_prompt
        if model_name is not None:
            update_data["model_name"] = model_name
        if provider_type is not None:
            update_data["provider_type"] = provider_type
        if available_tools is not None:
            update_data["available_tools"] = available_tools
        if think is not None:
            update_data["think"] = think
        if memory is not None:
            update_data["memory"] = memory
        if memory_enabled is not None:
            update_data["memory_enabled"] = memory_enabled
        if persona_id is not None:
            update_data["persona_id"] = persona_id
        if use_deferred_tools is not None:
            update_data["use_deferred_tools"] = use_deferred_tools

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
