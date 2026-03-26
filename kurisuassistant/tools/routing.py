"""Routing tool for Administrator agent to delegate to sub-agents."""

from typing import Dict, Any, List, Optional

from .base import BaseTool


class RouteToTool(BaseTool):
    """Tool for Administrator to route conversation to another agent.

    Only the Administrator agent gets this tool. Sub-agents respond directly
    and control returns to Administrator automatically.
    """

    name = "route_to"
    description = "Route the conversation to another agent"
    requires_approval = False
    risk_level = "low"
    built_in = True

    def __init__(self, available_agents: Optional[List[Dict[str, str]]] = None):
        """Initialize with list of available agents.

        Args:
            available_agents: List of dicts with 'name' and 'description' keys
        """
        self.available_agents = available_agents or []

    def get_schema(self) -> Dict[str, Any]:
        """Return Ollama-compatible tool schema."""
        agent_list = "\n".join(
            f"- {a['name']}: {a['description']}"
            for a in self.available_agents
        ) if self.available_agents else "No agents available"

        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": f"Route the conversation to another agent. Available agents:\n{agent_list}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_name": {
                            "type": "string",
                            "description": "Name of the agent to route to",
                        },
                        "message": {
                            "type": "string",
                            "description": "Summary of the conversation context and the task for the target agent",
                        },
                    },
                    "required": ["agent_name", "message"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        """Execute routing (returns confirmation for orchestration loop to process)."""
        agent_name = args.get("agent_name", "")
        message = args.get("message", "")
        return f"ROUTE_TO:{agent_name}:{message}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Route conversation to '{args.get('agent_name')}'"


def parse_route_result(result: str) -> Optional[Dict[str, str]]:
    """Parse route_to tool result.

    Returns:
        Dict with 'agent_name' and 'message', or None if not a route result
    """
    if result.startswith("ROUTE_TO:"):
        parts = result[len("ROUTE_TO:"):].split(":", 1)
        return {
            "agent_name": parts[0] if parts else "",
            "message": parts[1] if len(parts) > 1 else "",
        }
    return None
