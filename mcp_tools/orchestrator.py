"""Per-user MCP tools orchestration with caching and execution.

This module provides a per-user orchestrator registry for managing MCP tools:
- Each user gets their own orchestrator with their configured servers
- Servers are loaded from the database (mcp_servers table)
- Caching tools with 30-second TTL
- Executing tool calls with conversation_id injection
"""

import time
import datetime
import logging
from typing import Optional, List, Dict, Any

import httpx
from fastmcp.client import Client as FastMCPClient

from .client import list_tools, call_tool

logger = logging.getLogger(__name__)

_httpx_factory = lambda **kwargs: httpx.AsyncClient(verify=False, follow_redirects=True, **kwargs)


def _patch_httpx_factory(client: FastMCPClient):
    """Patch the FastMCPClient transport to use our custom httpx factory."""
    t = client.transport
    for obj in [t, getattr(t, "transport", None)]:
        if obj is not None and hasattr(obj, "httpx_client_factory"):
            obj.httpx_client_factory = _httpx_factory


def _create_client_from_server(server) -> Optional[FastMCPClient]:
    """Create a FastMCPClient from a single MCPServer DB row."""
    if server.transport_type == "sse" and server.url:
        config = {"mcpServers": {server.name: {"url": server.url}}}
    elif server.transport_type == "stdio" and server.command:
        entry: Dict[str, Any] = {"command": server.command}
        if server.args:
            entry["args"] = server.args
        if server.env:
            entry["env"] = server.env
        config = {"mcpServers": {server.name: entry}}
    else:
        return None

    client = FastMCPClient(config)
    _patch_httpx_factory(client)
    return client


def _create_client_from_servers(servers) -> Optional[FastMCPClient]:
    """Create a single FastMCPClient from multiple MCPServer DB rows."""
    mcp_servers: Dict[str, Any] = {}
    for server in servers:
        if server.transport_type == "sse" and server.url:
            mcp_servers[server.name] = {"url": server.url}
        elif server.transport_type == "stdio" and server.command:
            entry: Dict[str, Any] = {"command": server.command}
            if server.args:
                entry["args"] = server.args
            if server.env:
                entry["env"] = server.env
            mcp_servers[server.name] = entry

    if not mcp_servers:
        return None

    config = {"mcpServers": mcp_servers}
    client = FastMCPClient(config)
    _patch_httpx_factory(client)
    return client


class UserMCPOrchestrator:
    """Per-user orchestrator for MCP tool management and execution."""

    def __init__(self, user_id: int):
        self.user_id = user_id
        self.mcp_client: Optional[FastMCPClient] = None
        self._cached_tools: List[Dict] = []
        self._tools_cache_time: float = 0
        self._cache_ttl: int = 30

    def _load_servers(self):
        """Load enabled servers from DB and rebuild the MCP client."""
        from db.session import get_session
        from db.repositories import MCPServerRepository

        with get_session() as session:
            repo = MCPServerRepository(session)
            servers = repo.list_enabled_by_user(self.user_id)
            self.mcp_client = _create_client_from_servers(servers)

    def invalidate(self):
        """Reset cache, forcing reload on next call."""
        self._tools_cache_time = 0

    async def get_tools(self) -> List[Dict]:
        """Get MCP tools with caching."""
        current_time = time.time()

        if current_time - self._tools_cache_time > self._cache_ttl:
            self._load_servers()
            if self.mcp_client is not None:
                try:
                    self._cached_tools = await list_tools(self.mcp_client)
                    self._tools_cache_time = current_time
                except Exception as e:
                    logger.error(f"Error getting MCP tools for user {self.user_id}: {e}")
                    self._cached_tools = []
            else:
                self._cached_tools = []

        return self._cached_tools

    async def execute_tool_calls(
        self,
        tool_calls: List[Any],
        conversation_id: Optional[int] = None,
    ) -> List[Dict]:
        """Execute tool calls and return results as message dictionaries."""
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


# Per-user orchestrator registry
_orchestrators: Dict[int, UserMCPOrchestrator] = {}


def get_user_orchestrator(user_id: int) -> UserMCPOrchestrator:
    """Get or create a per-user MCP orchestrator."""
    if user_id not in _orchestrators:
        _orchestrators[user_id] = UserMCPOrchestrator(user_id)
    return _orchestrators[user_id]


def invalidate_user_orchestrator(user_id: int) -> None:
    """Invalidate a user's orchestrator cache (after CRUD operations)."""
    if user_id in _orchestrators:
        _orchestrators[user_id].invalidate()


# Backward compatibility
def init_orchestrator() -> None:
    """No-op for backward compatibility."""
    pass


def get_orchestrator() -> UserMCPOrchestrator:
    """Backward-compatible getter (returns user_id=0 instance)."""
    return get_user_orchestrator(0)
