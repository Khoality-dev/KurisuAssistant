"""Routing tools for Administrator agent to delegate to sub-agents or user."""

from typing import Dict, Any, List, Optional

from .base import BaseTool


class RouteToTool(BaseTool):
    """Single route_to tool used by the orchestration loop in handlers.py."""

    name = "route_to"
    description = "Route the conversation to another agent"
    requires_approval = False
    risk_level = "low"
    built_in = True

    def __init__(self, available_agents: Optional[List[Dict[str, str]]] = None):
        self.available_agents = available_agents or []

    def get_schema(self) -> Dict[str, Any]:
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
        agent_name = args.get("agent_name", "")
        message = args.get("message", "")
        return f"ROUTE_TO:{agent_name}:{message}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Route conversation to '{args.get('agent_name')}'"


def parse_route_result(result: str) -> Optional[Dict[str, str]]:
    """Parse route_to tool result (used by handlers.py orchestration loop)."""
    if result.startswith("ROUTE_TO:"):
        parts = result[len("ROUTE_TO:"):].split(":", 1)
        return {
            "agent_name": parts[0] if parts else "",
            "message": parts[1] if len(parts) > 1 else "",
        }
    return None


class RouteToAgentTool(BaseTool):
    """Tool for Administrator to route conversation to a specific agent."""

    name = "route_to_agent"
    description = "Route the conversation to a specific agent"
    requires_approval = False
    risk_level = "low"
    built_in = True

    def __init__(self, agent_names: List[str]):
        self.agent_names = agent_names

    def get_schema(self) -> Dict[str, Any]:
        agent_list = ", ".join(self.agent_names) if self.agent_names else "none"
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": f"Route the conversation to a specific agent. Available agents: {agent_list}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_name": {
                            "type": "string",
                            "description": "Name of the agent to route to",
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief reason for this routing decision",
                        },
                    },
                    "required": ["agent_name"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        agent_name = args.get("agent_name", "")
        reason = args.get("reason", "")
        return f"ROUTE_TO_AGENT:{agent_name}:{reason}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Route conversation to '{args.get('agent_name')}'"


class RouteToUserTool(BaseTool):
    """Tool for Administrator to return conversation control to the user."""

    name = "route_to_user"
    description = "Return the conversation to the user (it's their turn to speak)"
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": "Return the conversation to the user (it's their turn to speak)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "Brief reason for returning to user",
                        },
                    },
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        reason = args.get("reason", "")
        return f"ROUTE_TO_USER::{reason}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return "Return conversation to user"


def create_routing_tools(agent_names: List[str]) -> List[BaseTool]:
    """Create the routing tools for the Administrator agent."""
    return [RouteToAgentTool(agent_names), RouteToUserTool()]


def parse_routing_result(result: str) -> Dict[str, str]:
    """Parse a routing tool result.

    Returns:
        Dict with 'action', 'agent_name', and 'reason'
    """
    if result.startswith("ROUTE_TO_AGENT:"):
        parts = result[len("ROUTE_TO_AGENT:"):].split(":", 1)
        return {
            "action": "route_to_agent",
            "agent_name": parts[0] if parts else "",
            "reason": parts[1] if len(parts) > 1 else "",
        }
    elif result.startswith("ROUTE_TO_USER:"):
        parts = result[len("ROUTE_TO_USER:"):].split(":", 1)
        return {
            "action": "route_to_user",
            "agent_name": None,
            "reason": parts[1] if len(parts) > 1 else "",
        }
    return {"action": "route_to_user", "agent_name": None, "reason": "Unknown result"}
