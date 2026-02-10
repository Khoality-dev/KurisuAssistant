"""MCP tools orchestration with caching and execution.

This module provides a singleton orchestrator for managing MCP tools:
- Caching tools with 30-second TTL
- Executing tool calls with conversation_id injection
"""

import time
import datetime
import logging
from typing import Optional, List, Dict, Any

from .client import list_tools, call_tool

logger = logging.getLogger(__name__)


class MCPOrchestrator:
    """Orchestrator for MCP tool management and execution."""

    def __init__(self, mcp_client):
        """Initialize the orchestrator with an MCP client.

        Args:
            mcp_client: MCP client instance
        """
        self.mcp_client = mcp_client
        self._cached_tools: List[Dict] = []
        self._tools_cache_time: float = 0
        self._cache_ttl: int = 30  # Cache TTL in seconds

    async def get_tools(self) -> List[Dict]:
        """Get MCP tools with caching to avoid repeated connections.

        Returns:
            List of tool dictionaries
        """
        current_time = time.time()

        # Cache tools for 30 seconds to reduce MCP client connection overhead
        if current_time - self._tools_cache_time > self._cache_ttl:
            if self.mcp_client is not None:
                try:
                    self._cached_tools = await list_tools(self.mcp_client)
                    self._tools_cache_time = current_time
                except Exception as e:
                    logger.error(f"Error getting MCP tools: {e}")
                    self._cached_tools = []
            else:
                self._cached_tools = []

        return self._cached_tools

    async def execute_tool_calls(
        self,
        tool_calls: List[Any],
        conversation_id: Optional[int] = None
    ) -> List[Dict]:
        """Execute tool calls and return results as message dictionaries.

        Args:
            tool_calls: List of tool call objects from LLM
            conversation_id: Optional conversation ID for context injection

        Returns:
            List of tool message dictionaries with role="tool"
        """
        tool_messages = []

        for tool_call in tool_calls:
            if self.mcp_client is not None:
                try:
                    result = await call_tool(
                        self.mcp_client,
                        tool_call.function.name,
                        tool_call.function.arguments,
                        conversation_id=conversation_id,
                    )
                    tool_text = result[0].text
                except Exception as e:
                    tool_text = f"Error executing tool {tool_call.function.name}: {e}"
            else:
                tool_text = "MCP client not available"

            created_at = datetime.datetime.utcnow().isoformat()
            tool_message = {
                "role": "tool",
                "content": tool_text,
                "tool_name": tool_call.function.name,
                "created_at": created_at,
            }
            tool_messages.append(tool_message)

        return tool_messages


# Module-level singleton instance (initialized at app startup)
_orchestrator: Optional[MCPOrchestrator] = None


def init_orchestrator(mcp_client) -> None:
    """Initialize the global MCP orchestrator.

    This should be called once at application startup.

    Args:
        mcp_client: MCP client instance
    """
    global _orchestrator
    _orchestrator = MCPOrchestrator(mcp_client)


def get_orchestrator() -> MCPOrchestrator:
    """Get the global MCP orchestrator instance.

    Returns:
        MCPOrchestrator instance

    Raises:
        RuntimeError: If orchestrator not initialized
    """
    if _orchestrator is None:
        raise RuntimeError("MCP orchestrator not initialized. Call init_orchestrator() first.")
    return _orchestrator
