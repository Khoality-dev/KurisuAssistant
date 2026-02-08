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
        voice_reference: Optional[str] = None,
        avatar_uuid: Optional[str] = None,
        model_name: Optional[str] = None,
        tools: Optional[List[str]] = None,
        think: bool = False,
    ) -> Agent:
        """Create a new agent.

        Args:
            user_id: User ID who owns the agent
            name: Agent display name
            system_prompt: Custom personality prompt
            voice_reference: Voice file name for TTS
            avatar_uuid: Avatar image UUID
            model_name: LLM model override
            tools: List of tool names

        Returns:
            Created Agent instance

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
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
            model_name=model_name,
            tools=tools,
            think=think,
        )

    def update_agent(
        self,
        agent: Agent,
        name: Optional[str] = None,
        system_prompt: Optional[str] = None,
        voice_reference: Optional[str] = None,
        avatar_uuid: Optional[str] = None,
        model_name: Optional[str] = None,
        tools: Optional[List[str]] = None,
        think: Optional[bool] = None,
    ) -> Agent:
        """Update an agent.

        Args:
            agent: Agent to update
            name: New name (optional)
            system_prompt: New prompt (optional)
            voice_reference: New voice reference (optional)
            avatar_uuid: New avatar UUID (optional)
            model_name: New model name (optional)
            tools: New tools list (optional)

        Returns:
            Updated Agent instance
        """
        update_data = {}
        if name is not None:
            update_data["name"] = name
        if system_prompt is not None:
            update_data["system_prompt"] = system_prompt
        if voice_reference is not None:
            update_data["voice_reference"] = voice_reference
        if avatar_uuid is not None:
            update_data["avatar_uuid"] = avatar_uuid
        if model_name is not None:
            update_data["model_name"] = model_name
        if tools is not None:
            update_data["tools"] = tools
        if think is not None:
            update_data["think"] = think

        if update_data:
            return self.update(agent, **update_data)
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
