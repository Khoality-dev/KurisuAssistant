"""MCP tools orchestration with caching and execution.

This module provides a singleton orchestrator for managing MCP tools:
- Re-reads mcp_config.json on each cache refresh (no restart needed)
- Caching tools with 30-second TTL
- Executing tool calls with conversation_id injection
"""

import time
import datetime
import logging
from typing import Optional, List, Dict, Any

import httpx
from fastmcp.client import Client as FastMCPClient

from .config import load_mcp_configs
from .client import list_tools, call_tool

logger = logging.getLogger(__name__)

_httpx_factory = lambda **kwargs: httpx.AsyncClient(verify=False, follow_redirects=True, **kwargs)


def _create_client_from_config():
    """Create a FastMCPClient from mcp_config.json, or None if empty."""
    configs = load_mcp_configs()
    if not configs.get("mcpServers"):
        return None, configs

    client = FastMCPClient(configs)
    t = client.transport
    for obj in [t, getattr(t, "transport", None)]:
        if obj is not None and hasattr(obj, "httpx_client_factory"):
            obj.httpx_client_factory = _httpx_factory
    return client, configs


class MCPOrchestrator:
    """Orchestrator for MCP tool management and execution."""

    def __init__(self):
        self.mcp_client = None
        self.mcp_configs: Dict = {}
        self._cached_tools: List[Dict] = []
        self._tools_cache_time: float = 0
        self._cache_ttl: int = 30  # Cache TTL in seconds

    def _refresh_client(self):
        """Re-read config and rebuild the MCP client."""
        self.mcp_client, self.mcp_configs = _create_client_from_config()

    async def get_tools(self) -> List[Dict]:
        """Get MCP tools with caching to avoid repeated connections.

        Returns:
            List of tool dictionaries
        """
        current_time = time.time()

        # Cache tools for 30 seconds to reduce MCP client connection overhead
        if current_time - self._tools_cache_time > self._cache_ttl:
            self._refresh_client()
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


def init_orchestrator() -> None:
    """Initialize the global MCP orchestrator.

    This should be called once at application startup.
    """
    global _orchestrator
    _orchestrator = MCPOrchestrator()


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
