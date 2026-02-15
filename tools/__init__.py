"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .routing import RouteToAgentTool, RouteToUserTool
from .context import SearchMessagesTool, GetConversationInfoTool, GetFrameSummariesTool, GetFrameMessagesTool
from .media import PlayMusicTool, MusicControlTool, GetMusicQueueTool
from .skills import GetSkillInstructionsTool

# Register built-in tools
tool_registry.register(RouteToAgentTool())
tool_registry.register(RouteToUserTool())
tool_registry.register(SearchMessagesTool())
tool_registry.register(GetConversationInfoTool())
tool_registry.register(GetFrameSummariesTool())
tool_registry.register(GetFrameMessagesTool())
tool_registry.register(PlayMusicTool())
tool_registry.register(MusicControlTool())
tool_registry.register(GetMusicQueueTool())
tool_registry.register(GetSkillInstructionsTool())

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
