"""Agent system — two concrete agents with distinct roles.

MainAgent: has identity, streams to the user, can delegate to SubAgents.
SubAgent: task-only, invisible to the user, returns a single string to its caller.
"""

from .base import BaseAgent, AgentConfig, AgentContext, ToolResult
from .main import MainAgent
from .sub import SubAgent, SubAgentTool

__all__ = [
    "BaseAgent",
    "AgentConfig",
    "AgentContext",
    "ToolResult",
    "MainAgent",
    "SubAgent",
    "SubAgentTool",
]
