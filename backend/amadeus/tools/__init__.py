"""Unified tool system."""

from .base import BaseTool
from .registry import ToolRegistry, tool_registry
from .history import HistoryListTool, HistoryReadTool
from .recall import RecallRegexTool, RecallSemanticTool
from .skills import GetSkillInstructionsTool
from .drive import DriveDeleteTool, DriveListTool, DriveReadTool, DriveWriteTool
from .notify import NotifyUserTool
from .tasks import TASK_TOOLS
from .calendar import CalendarCreateTool, CalendarDeleteTool, CalendarListTool, CalendarMoveTool, CalendarRepeatTool

# Register the server's own tools
tool_registry.register(HistoryListTool())
tool_registry.register(HistoryReadTool())
# Recall replaces history_search (#6): the same index over conversations *and*
# drive files, reached by pattern or by meaning (see tools/recall.py).
tool_registry.register(RecallRegexTool())
tool_registry.register(RecallSemanticTool())
tool_registry.register(GetSkillInstructionsTool())
# Reaching the user outside the chat (#353): never waits, in any permission mode.
tool_registry.register(NotifyUserTool())
# Every tool here is always offered (#360); the account's permission mode decides
# what a call does, from each tool's `read_only` (see docs/tools.md).
tool_registry.register(DriveListTool())
tool_registry.register(DriveReadTool())
tool_registry.register(DriveWriteTool())
tool_registry.register(DriveDeleteTool())
# Note: delegate_task (agents/sub.py) is injected per turn, not registered globally:
# it needs the assistant's own configuration to spawn a sub-agent.
# The task tools (#352): planning its own work is part of what the assistant is,
# and every call goes through the permission mode.
for _task_tool in TASK_TOOLS:
    tool_registry.register(_task_tool())
# The calendar (#282) is one of the assistant's own features (#268). A reminder only ever notifies the user; nothing on the
# calendar makes the assistant act (see tools/calendar.py).
tool_registry.register(CalendarCreateTool())
tool_registry.register(CalendarListTool())
tool_registry.register(CalendarMoveTool())
tool_registry.register(CalendarRepeatTool())
tool_registry.register(CalendarDeleteTool())

__all__ = [
    "BaseTool",
    "ToolRegistry",
    "tool_registry",
]
