"""Handoff tool for transferring conversation between main agents."""

from typing import Any, Dict, List, Optional

from .base import BaseTool


class HandoffToTool(BaseTool):
    """Tool for main agents to transfer conversation to another main agent.

    This is an internal tool - the handoff happens silently without
    exposing events to the frontend. The new agent simply continues
    the conversation.
    """

    name = "handoff_to"
    description = "Transfer this conversation to another agent who is better suited to help"
    built_in = True

    def __init__(self, available_agents: Optional[List[Dict[str, str]]] = None):
        """Initialize with list of available agents.

        Args:
            available_agents: List of dicts with 'name' and 'description' keys
        """
        self.available_agents = available_agents or []

    def get_schema(self) -> Dict[str, Any]:
        """Return the tool schema for the LLM."""
        if self.available_agents:
            agent_list = "\n".join(
                f"- {a['name']}: {a['description']}"
                for a in self.available_agents
            )
        else:
            agent_list = "No other agents available"

        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": f"Transfer conversation to another agent. Use this when the user's request is better handled by a different agent.\n\nAvailable agents:\n{agent_list}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_name": {
                            "type": "string",
                            "description": "Name of the agent to hand off to",
                        },
                        "context": {
                            "type": "string",
                            "description": "Brief context about what the user needs (passed to the new agent)",
                        },
                    },
                    "required": ["agent_name"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        """Execute the handoff by returning a special marker string.

        The handler will detect this marker and switch to the target agent.
        """
        agent_name = args.get("agent_name", "")
        context = args.get("context", "")

        # Return special marker that handlers.py will detect
        return f"HANDOFF:{agent_name}:{context}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        """Human-readable description of the tool call."""
        return f"Handing off to {args.get('agent_name', 'another agent')}"


def parse_handoff_result(result: str) -> Optional[Dict[str, str]]:
    """Parse a handoff tool result to extract target agent and context.

    Args:
        result: The tool result string

    Returns:
        Dict with 'agent_name' and 'context' if this is a handoff result,
        None otherwise
    """
    if not result.startswith("HANDOFF:"):
        return None

    # Format: "HANDOFF:agent_name:context"
    parts = result[len("HANDOFF:"):].split(":", 1)
    return {
        "agent_name": parts[0] if parts else "",
        "context": parts[1] if len(parts) > 1 else "",
    }
