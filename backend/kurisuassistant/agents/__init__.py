"""Agent system — two concrete agents with distinct roles.

MainAgent: runs the user's single assistant (model, tools, memory) in a
persona's voice, streams to the user, can delegate to SubAgents.
SubAgent: task-only, invisible to the user, returns a single string to its caller.
"""

from .base import (
    BaseAgent,
    AgentContext,
    AssistantConfig,
    PersonaConfig,
    SubAgentConfig,
    ToolResult,
)
from .main import MainAgent
from .sub import SubAgent, SubAgentTool

__all__ = [
    "BaseAgent",
    "AgentContext",
    "AssistantConfig",
    "PersonaConfig",
    "SubAgentConfig",
    "ToolResult",
    "MainAgent",
    "SubAgent",
    "SubAgentTool",
]
