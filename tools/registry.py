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

    def get_schemas(self, tool_names: Optional[List[str]] = None) -> List[Dict]:
        """Get Ollama-compatible schemas for native tools.

        Args:
            tool_names: List of tool names to get, or None for all

        Returns:
            List of tool schemas
        """
        schemas = []

        # Built-in tools are always included; other native tools filtered by tool_names
        for name, tool in self._tools.items():
            if tool.built_in or tool_names is None or name in tool_names:
                schemas.append(tool.get_schema())

        return schemas

    def get_native_tool_info(self) -> List[Dict]:
        """Get schemas for all native tools, each tagged with built_in flag."""
        results = []
        for tool in self._tools.values():
            schema = tool.get_schema()
            schema["built_in"] = tool.built_in
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
