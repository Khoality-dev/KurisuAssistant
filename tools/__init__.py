"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .context import SearchMessagesTool, GetConversationInfoTool, GetFrameSummariesTool, GetFrameMessagesTool
from .skills import GetSkillInstructionsTool
from .knowledge import QueryKnowledgeTool

# Register built-in tools
tool_registry.register(SearchMessagesTool())
tool_registry.register(GetConversationInfoTool())
tool_registry.register(GetFrameSummariesTool())
tool_registry.register(GetFrameMessagesTool())
tool_registry.register(GetSkillInstructionsTool())
tool_registry.register(QueryKnowledgeTool())

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
