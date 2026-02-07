"""Turn-based orchestration session management."""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any


@dataclass
class OrchestrationSession:
    """Tracks turn-based conversation state.

    The Administrator orchestrator manages turns between agents.
    Each "turn" is one agent processing a message.
    """
    conversation_id: int
    frame_id: int
    user_id: int
    turn_count: int = 0
    max_turns: int = 10
    current_agent_id: Optional[int] = None
    current_agent_name: Optional[str] = None
    is_cancelled: bool = False
    pending_routes: List[Dict[str, Any]] = field(default_factory=list)

    def increment_turn(self) -> bool:
        """Increment turn counter and check if we can continue.

        Returns:
            True if we haven't exceeded max turns, False otherwise
        """
        self.turn_count += 1
        return self.turn_count <= self.max_turns

    def cancel(self) -> None:
        """Mark session as cancelled."""
        self.is_cancelled = True

    def set_current_agent(self, agent_id: Optional[int], agent_name: Optional[str]) -> None:
        """Update the current active agent."""
        self.current_agent_id = agent_id
        self.current_agent_name = agent_name


@dataclass
class AdministratorDecision:
    """Decision made by Administrator after analyzing a response.

    The Administrator uses LLM to determine:
    - Who should receive the message (user or another agent)
    - Whether the conversation should continue
    """
    target_type: str  # "user" or "agent"
    target_agent_id: Optional[int] = None
    target_agent_name: Optional[str] = None
    reason: str = ""  # For logging
    should_continue: bool = True  # False if conversation should end

    @classmethod
    def to_user(cls, reason: str = "") -> "AdministratorDecision":
        """Create decision to route to user."""
        return cls(
            target_type="user",
            reason=reason,
            should_continue=False,  # User turn ends the orchestration loop
        )

    @classmethod
    def to_agent(
        cls,
        agent_id: int,
        agent_name: str,
        reason: str = "",
    ) -> "AdministratorDecision":
        """Create decision to route to another agent."""
        return cls(
            target_type="agent",
            target_agent_id=agent_id,
            target_agent_name=agent_name,
            reason=reason,
            should_continue=True,
        )

    @classmethod
    def complete(cls, reason: str = "") -> "AdministratorDecision":
        """Create decision that the conversation topic is complete."""
        return cls(
            target_type="user",
            reason=reason,
            should_continue=False,
        )
