"""Tool registry for managing available tools."""

import logging
from typing import Dict, List, Optional

from .base import BaseTool

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Central registry for all tools."""

    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}
        self._mcp_tools: Dict[str, Dict] = {}  # MCP tool schemas

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

    def register_mcp_tools(self, mcp_tools: List[Dict]) -> None:
        """Register MCP tools from orchestrator.

        Args:
            mcp_tools: List of MCP tool schemas
        """
        for tool in mcp_tools:
            name = tool.get("function", {}).get("name", "")
            if name:
                self._mcp_tools[name] = tool
                logger.debug(f"Registered MCP tool: {name}")

    def get_schemas(self, tool_names: Optional[List[str]] = None) -> List[Dict]:
        """Get Ollama-compatible schemas for tools.

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

        # MCP tools filtered by tool_names
        for name, schema in self._mcp_tools.items():
            if tool_names is None or name in tool_names:
                schemas.append(schema)

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
        return list(self._tools.keys()) + list(self._mcp_tools.keys())

    def is_mcp_tool(self, name: str) -> bool:
        """Check if a tool is an MCP tool.

        Args:
            name: Tool name

        Returns:
            True if MCP tool
        """
        return name in self._mcp_tools


# Global tool registry instance
tool_registry = ToolRegistry()
