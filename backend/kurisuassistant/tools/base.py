"""Base tool interface."""

from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseTool(ABC):
    """Abstract base class for all tools."""

    name: str
    description: str
    built_in: bool = False  # Built-in tools are always available to all agents
    # Runs without asking when the user has stored no policy for it (#353). A
    # stored "deny" still refuses it, and it is listed in Settings → Tools so it
    # can be denied. For tools whose whole effect is on the user's own account
    # and that a task with nobody attached must be able to use — notify_user.
    # Off for everything else: no policy means ask.
    allowed_by_default: bool = False

    @abstractmethod
    def get_schema(self) -> Dict[str, Any]:
        """Return Ollama-compatible tool schema.

        Returns:
            Dict with structure:
            {
                "type": "function",
                "function": {
                    "name": "tool_name",
                    "description": "...",
                    "parameters": {...}
                }
            }
        """
        pass

    @abstractmethod
    async def execute(self, args: Dict[str, Any]) -> str:
        """Execute the tool with given arguments.

        Args:
            args: Tool arguments

        Returns:
            Result as string
        """
        pass

    def describe_call(self, args: Dict[str, Any]) -> str:
        """Return human-readable description of what this call will do.

        Args:
            args: Tool arguments

        Returns:
            Human-readable description
        """
        return f"Execute {self.name} with args: {args}"
