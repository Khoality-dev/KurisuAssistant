"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .history import HistoryListTool, HistoryReadTool, HistorySearchTool
from .skills import GetSkillInstructionsTool
from .routing import RouteToTool, RouteToUserTool

# Register built-in tools
tool_registry.register(HistoryListTool())
tool_registry.register(HistoryReadTool())
tool_registry.register(HistorySearchTool())
tool_registry.register(GetSkillInstructionsTool())
tool_registry.register(RouteToTool())
tool_registry.register(RouteToUserTool())

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
