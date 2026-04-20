"""Sub-agent tool wrapper - allows main agents to delegate tasks to sub-agents."""

import logging
from typing import Any, Dict

from .base import BaseTool

logger = logging.getLogger(__name__)


class SubAgentTool(BaseTool):
    """Wraps a sub-agent as a callable tool.

    Sub-agents are agents with agent_type='sub'. They have their own
    system prompt and model but no personality (voice/avatar).

    When a main agent calls a sub-agent tool:
    1. The sub-agent receives only the task (not full conversation)
    2. Sub-agent processes with its own LLM call
    3. Result is returned to the main agent as tool output
    4. Main agent continues with the result
    """

    built_in = False

    def __init__(self, agent_config: "AgentConfig"):
        """Initialize with a sub-agent's configuration.

        Args:
            agent_config: The AgentConfig for the sub-agent
        """
        from kurisuassistant.agents.base import AgentConfig

        self.agent_config = agent_config
        self.name = self._to_tool_name(agent_config.name)
        self.description = agent_config.description or f"Delegate task to {agent_config.name}"

    @staticmethod
    def _to_tool_name(agent_name: str) -> str:
        """Convert agent name to a valid tool name (snake_case)."""
        # Replace spaces and special chars with underscores
        name = agent_name.lower()
        name = "".join(c if c.isalnum() else "_" for c in name)
        # Remove consecutive underscores
        while "__" in name:
            name = name.replace("__", "_")
        return name.strip("_") + "_agent"

    def get_schema(self) -> Dict[str, Any]:
        """Return the tool schema for the LLM."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": f"Delegate a task to {self.agent_config.name}. {self.description}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "The task or question to send to this sub-agent",
                        },
                    },
                    "required": ["task"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        """Execute the sub-agent with the given task.

        Args:
            args: Must contain 'task' and '_context' (injected by caller)

        Returns:
            The sub-agent's response as a string
        """
        from kurisuassistant.agents.base import ChatAgent, AgentContext
        from kurisuassistant.tools import tool_registry

        task = args.get("task", "")
        context: AgentContext = args.get("_context")

        if not context:
            return "Error: No context provided for sub-agent execution"

        if not task:
            return "Error: No task provided"

        logger.info(f"Sub-agent '{self.agent_config.name}' executing task: {task[:100]}...")

        try:
            # Create sub-agent instance
            sub_agent = ChatAgent(self.agent_config, tool_registry)

            # Build messages for sub-agent (just the task, no history)
            messages = [{"role": "user", "content": task}]

            # Run sub-agent and collect full response (non-streaming internally)
            full_response = ""
            async for chunk in sub_agent.process(messages, context):
                if chunk.role == "assistant" and chunk.content:
                    full_response += chunk.content

            logger.info(f"Sub-agent '{self.agent_config.name}' completed, response length: {len(full_response)}")
            return full_response or "Sub-agent completed with no response"

        except Exception as e:
            logger.error(f"Sub-agent execution failed: {e}")
            return f"Sub-agent error: {str(e)}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        """Human-readable description of the tool call."""
        task = args.get("task", "")
        return f"Asking {self.agent_config.name}: {task[:100]}..."
