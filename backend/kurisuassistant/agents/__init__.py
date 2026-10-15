"""Agent system — two concrete agents with distinct roles.

MainAgent: runs the user's single assistant (model, tools, memory) as the persona
in use, streams to the user, and can spawn sub-agents through ``delegate_task``.
SubAgent: spawned on the spot on the assistant's own model and tools; task-only,
invisible to the user, returns a single string to its caller.
"""

from .base import (
    BaseAgent,
    AgentContext,
    AssistantConfig,
    PersonaConfig,
    ToolResult,
)
from .main import MainAgent
from .sub import DelegateTaskTool, SubAgent

__all__ = [
    "BaseAgent",
    "AgentContext",
    "AssistantConfig",
    "PersonaConfig",
    "ToolResult",
    "MainAgent",
    "SubAgent",
    "DelegateTaskTool",
]
