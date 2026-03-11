"""Per-user MCP tools orchestration with caching and execution.

This module provides a per-user orchestrator registry for managing MCP tools:
- Each user gets their own orchestrator with their configured servers
- Servers are loaded from the database (mcp_servers table)
- Each server gets its own FastMCPClient (no composite/proxy)
- Tool name → client mapping for direct routing
- Caching tools with 30-second TTL
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


class UserMCPOrchestrator:
    """Per-user orchestrator for MCP tool management and execution.

    Uses per-server clients instead of a composite client to avoid
    tool name prefixing and proxy reconnection issues.
    """

    def __init__(self, user_id: int):
        self.user_id = user_id
        self._server_clients: Dict[str, FastMCPClient] = {}
        self._tool_to_client: Dict[str, FastMCPClient] = {}
        self._cached_tools: List[Dict] = []
        self._tools_cache_time: float = 0
        self._cache_ttl: int = 30

    def _load_servers(self):
        """Load enabled server-side servers from DB and rebuild per-server clients.

        Only loads servers with location="server" (or NULL for backwards compat).
        Client-side servers are managed by the Electron app.
        """
        from db.session import get_session
        from db.repositories import MCPServerRepository

        with get_session() as session:
            repo = MCPServerRepository(session)
            servers = repo.list_enabled_by_user(self.user_id, location="server")

        self._server_clients.clear()
        for server in servers:
            client = _create_client_from_server(server)
            if client:
                self._server_clients[server.name] = client

    def invalidate(self):
        """Reset cache, forcing reload on next call."""
        self._tools_cache_time = 0

    async def get_tools(self) -> List[Dict]:
        """Get MCP tools with caching (flat list from all servers)."""
        current_time = time.time()

        if current_time - self._tools_cache_time > self._cache_ttl:
            self._load_servers()
            all_tools: List[Dict] = []
            tool_to_client: Dict[str, FastMCPClient] = {}

            for server_name, client in self._server_clients.items():
                try:
                    tools = await list_tools(client)
                    for tool in tools:
                        tool_name = tool.get("function", {}).get("name", "")
                        if tool_name:
                            tool_to_client[tool_name] = client
                    all_tools.extend(tools)
                except Exception as e:
                    logger.error(f"Error getting MCP tools from '{server_name}' for user {self.user_id}: {e}")

            self._cached_tools = all_tools
            self._tool_to_client = tool_to_client
            self._tools_cache_time = current_time

        return self._cached_tools

    def get_server_names(self) -> List[str]:
        """Get enabled server-side server names for the user."""
        from db.session import get_session
        from db.repositories import MCPServerRepository

        with get_session() as session:
            repo = MCPServerRepository(session)
            servers = repo.list_enabled_by_user(self.user_id, location="server")
            return [s.name for s in servers]

    async def execute_tool_calls(
        self,
        tool_calls: List[Any],
        conversation_id: Optional[int] = None,
    ) -> List[Dict]:
        """Execute tool calls and return results as message dictionaries."""
        tool_messages = []

        for tool_call in tool_calls:
            image_uuids = []
            tool_name = tool_call.function.name
            client = self._tool_to_client.get(tool_name)

            if client is not None:
                try:
                    result = await call_tool(
                        client,
                        tool_name,
                        tool_call.function.arguments,
                    )
                    text_parts = []
                    for block in result:
                        if hasattr(block, 'text'):
                            text_parts.append(block.text)
                        elif hasattr(block, 'data') and hasattr(block, 'mimeType'):
                            # ImageContent — save to user's directory
                            from utils.images import save_image_from_base64
                            try:
                                img_uuid = save_image_from_base64(block.data, self.user_id)
                                image_uuids.append(img_uuid)
                                text_parts.append(f"[Generated image: {img_uuid}]")
                            except Exception as e:
                                text_parts.append(f"[Failed to save image: {e}]")
                    tool_text = "\n".join(text_parts) if text_parts else ""
                except Exception as e:
                    tool_text = f"Error executing tool {tool_name}: {e}"
            else:
                tool_text = "MCP client not available"

            created_at = datetime.datetime.utcnow().isoformat()
            tool_message = {
                "role": "tool",
                "content": tool_text,
                "tool_name": tool_name,
                "created_at": created_at,
            }
            if image_uuids:
                tool_message["images"] = image_uuids
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
