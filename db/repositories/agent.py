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

    def get_main_agent(self, user_id: int) -> Optional[Agent]:
        """Get the main (router) agent for a user.

        Args:
            user_id: User ID

        Returns:
            Main Agent instance or None if not set
        """
        return self.get_by_filter(user_id=user_id, is_main=True)

    def set_main_agent(self, user_id: int, agent_id: int) -> Optional[Agent]:
        """Set an agent as the main (router) agent.

        This will unset any existing main agent for the user.

        Args:
            user_id: User ID who owns the agent
            agent_id: Agent ID to set as main

        Returns:
            Updated Agent instance or None if not found
        """
        # First, unset any existing main agent
        current_main = self.get_main_agent(user_id)
        if current_main:
            self.update(current_main, is_main=False)

        # Set the new main agent
        agent = self.get_by_user_and_id(user_id, agent_id)
        if agent:
            return self.update(agent, is_main=True)
        return None

    def create_agent(
        self,
        user_id: int,
        name: str,
        system_prompt: str = "",
        voice_reference: Optional[str] = None,
        avatar_uuid: Optional[str] = None,
        model_name: Optional[str] = None,
        tools: Optional[List[str]] = None,
        is_main: bool = False,
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
            is_main: Whether this is the main router agent

        Returns:
            Created Agent instance

        Raises:
            ValueError: If agent with same name exists for user
        """
        existing = self.get_by_user_and_name(user_id, name)
        if existing:
            raise ValueError(f"Agent '{name}' already exists")

        # If setting as main, unset any existing main agent
        if is_main:
            current_main = self.get_main_agent(user_id)
            if current_main:
                self.update(current_main, is_main=False)

        return self.create(
            user_id=user_id,
            name=name,
            system_prompt=system_prompt,
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
            model_name=model_name,
            tools=tools,
            is_main=is_main,
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
        is_main: Optional[bool] = None,
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
            is_main: Set as main agent (optional)

        Returns:
            Updated Agent instance
        """
        # If setting as main, unset any existing main agent first
        if is_main is True:
            current_main = self.get_main_agent(agent.user_id)
            if current_main and current_main.id != agent.id:
                self.update(current_main, is_main=False)

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
        if is_main is not None:
            update_data["is_main"] = is_main

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
