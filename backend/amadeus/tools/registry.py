"""Tool registry for managing available tools."""

import logging
from typing import Dict, List, Optional

from .base import BaseTool

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Central registry for all native tools."""

    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """Register a tool.

        Args:
            tool: Tool instance to register
        """
        self._tools[tool.name] = tool
        logger.debug(f"Registered tool: {tool.name}")

    def unregister(self, name: str) -> None:
        """Unregister a tool.

        Args:
            name: Tool name to unregister
        """
        if name in self._tools:
            del self._tools[name]
            logger.debug(f"Unregistered tool: {name}")

    def get(self, name: str) -> Optional[BaseTool]:
        """Get a tool by name.

        Args:
            name: Tool name

        Returns:
            Tool instance or None
        """
        return self._tools.get(name)

    def get_schemas(self) -> List[Dict]:
        """Ollama-compatible schemas for every native tool.

        Every tool is offered (#360); the permission mode decides what a call does.
        """
        return [tool.get_schema() for tool in self._tools.values()]

    def get_native_tool_info(self) -> List[Dict]:
        """Schemas for all native tools, each tagged with whether it only looks."""
        results = []
        for tool in self._tools.values():
            schema = tool.get_schema()
            schema["read_only"] = tool.read_only
            results.append(schema)
        return results

    def list_all(self) -> List[str]:
        """List all registered tool names.

        Returns:
            List of tool names
        """
        return list(self._tools.keys())


# Global tool registry instance
tool_registry = ToolRegistry()
