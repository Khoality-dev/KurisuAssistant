"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .history import HistoryListTool, HistoryReadTool
from .recall import RecallRegexTool, RecallSemanticTool
from .skills import GetSkillInstructionsTool
from .drive import DriveDeleteTool, DriveListTool, DriveReadTool, DriveWriteTool

# Register built-in tools
tool_registry.register(HistoryListTool())
tool_registry.register(HistoryReadTool())
# Recall replaces history_search (#6): the same index over conversations *and*
# drive files, reached by pattern or by meaning. Built-in like the history tools;
# document passages are still gated on drive_read (see tools/recall.py).
tool_registry.register(RecallRegexTool())
tool_registry.register(RecallSemanticTool())
tool_registry.register(GetSkillInstructionsTool())
# Drive tools are deliberately NOT built_in: an account with a narrowed
# `available_tools` should not silently gain file access, and the write and
# delete ones only ever run past `users.tool_policies` (see docs/tools.md).
tool_registry.register(DriveListTool())
tool_registry.register(DriveReadTool())
tool_registry.register(DriveWriteTool())
tool_registry.register(DriveDeleteTool())
# Note: HandoffToTool and SubAgentTool are injected dynamically per-session, not registered globally

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
