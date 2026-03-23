"""Routing tools for Administrator agent."""

from typing import Dict, Any, List, Optional

from .base import BaseTool


class RouteToAgentTool(BaseTool):
    """Tool for Administrator to route conversation to a specific agent."""

    name = "route_to_agent"
    description = "Route the conversation to a specific agent. Use this when the current message should be handled by another agent."
    requires_approval = False  # Administrator routing doesn't need user approval
    risk_level = "low"
    built_in = True

    def __init__(self, available_agents: Optional[List[str]] = None):
        """Initialize with list of available agent names."""
        self.available_agents = available_agents or []

    def get_schema(self) -> Dict[str, Any]:
        """Return Ollama-compatible tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_name": {
                            "type": "string",
                            "description": f"Name of the agent to route to. Available agents: {', '.join(self.available_agents) if self.available_agents else 'any'}",
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief explanation of why this agent should handle the message",
                        },
                    },
                    "required": ["agent_name", "reason"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        """Execute routing (returns confirmation for orchestration loop to process)."""
        agent_name = args.get("agent_name", "")
        reason = args.get("reason", "")
        # This result is parsed by the orchestration loop
        return f"ROUTE_TO_AGENT:{agent_name}:{reason}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Route conversation to agent '{args.get('agent_name')}'"


class RouteToUserTool(BaseTool):
    """Tool for Administrator to end the orchestration loop and return to user."""

    name = "route_to_user"
    description = "End the agent conversation loop and return control to the user. Use this when the agent's response is complete and ready for the user."
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        """Return Ollama-compatible tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "Brief explanation of why the conversation should return to the user",
                        },
                    },
                    "required": ["reason"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        """Execute routing (returns confirmation for orchestration loop to process)."""
        reason = args.get("reason", "")
        return f"ROUTE_TO_USER:{reason}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return "Return conversation to user"


def create_routing_tools(available_agents: List[str]) -> List[BaseTool]:
    """Create routing tools with available agent names.

    Args:
        available_agents: List of agent names that can be routed to

    Returns:
        List of routing tool instances
    """
    return [
        RouteToAgentTool(available_agents),
        RouteToUserTool(),
    ]


def parse_routing_result(result: str) -> Dict[str, Any]:
    """Parse routing tool result into structured decision.

    Args:
        result: Tool execution result string

    Returns:
        Dict with routing decision:
        {
            "action": "route_to_agent" | "route_to_user",
            "agent_name": str | None,
            "reason": str
        }
    """
    if result.startswith("ROUTE_TO_AGENT:"):
        parts = result[len("ROUTE_TO_AGENT:"):].split(":", 1)
        return {
            "action": "route_to_agent",
            "agent_name": parts[0] if parts else "",
            "reason": parts[1] if len(parts) > 1 else "",
        }
    elif result.startswith("ROUTE_TO_USER:"):
        reason = result[len("ROUTE_TO_USER:"):]
        return {
            "action": "route_to_user",
            "agent_name": None,
            "reason": reason,
        }
    else:
        # Default to user if can't parse
        return {
            "action": "route_to_user",
            "agent_name": None,
            "reason": "Could not parse routing decision",
        }
