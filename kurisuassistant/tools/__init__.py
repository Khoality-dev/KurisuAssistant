"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .history import HistoryListTool, HistoryReadTool, HistorySearchTool
from .notes import NotesListTool, NotesReadTool, NotesWriteTool, NotesEditTool, NotesDeleteTool, NotesSearchTool
from .skills import GetSkillInstructionsTool

# Register built-in tools
tool_registry.register(HistoryListTool())
tool_registry.register(HistoryReadTool())
tool_registry.register(HistorySearchTool())
tool_registry.register(NotesListTool())
tool_registry.register(NotesReadTool())
tool_registry.register(NotesWriteTool())
tool_registry.register(NotesEditTool())
tool_registry.register(NotesDeleteTool())
tool_registry.register(NotesSearchTool())
tool_registry.register(GetSkillInstructionsTool())

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
