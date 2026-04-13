"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .history import HistoryListTool, HistoryReadTool, HistorySearchTool
from .skills import GetSkillInstructionsTool

# Register built-in tools
tool_registry.register(HistoryListTool())
tool_registry.register(HistoryReadTool())
tool_registry.register(HistorySearchTool())
tool_registry.register(GetSkillInstructionsTool())
# Note: HandoffToTool and SubAgentTool are injected dynamically per-session, not registered globally

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
