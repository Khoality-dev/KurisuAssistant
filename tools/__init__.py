"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .routing import RouteToAgentTool, RouteToUserTool

# Register built-in routing tools
tool_registry.register(RouteToAgentTool())
tool_registry.register(RouteToUserTool())

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
