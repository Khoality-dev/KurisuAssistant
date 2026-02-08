"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .routing import RouteToAgentTool, RouteToUserTool
from .context import SearchMessagesTool, GetConversationInfoTool

# Register built-in tools
tool_registry.register(RouteToAgentTool())
tool_registry.register(RouteToUserTool())
tool_registry.register(SearchMessagesTool())
tool_registry.register(GetConversationInfoTool())

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
