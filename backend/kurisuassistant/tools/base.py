"""Base tool interface."""

from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseTool(ABC):
    """Abstract base class for all tools."""

    name: str
    description: str
    # Whether the tool only looks (#360): it reads, lists or searches and changes
    # nothing. The permission mode reads this — Read only runs such a tool without
    # asking and refuses every other one. Off unless a tool says so: a tool that
    # has not said counts as one that changes something.
    read_only: bool = False
    # Never waits, in any permission mode (#353): for a tool whose whole effect
    # is on the user's own devices and that a task with nobody attached must be
    # able to use — notify_user. Off for everything else.
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
