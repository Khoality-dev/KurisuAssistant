"""Tools management router."""

import logging
from fastapi import APIRouter, Depends

from core.deps import get_authenticated_user
from db.models import User
from tools.registry import tool_registry
from mcp_tools.orchestrator import get_user_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("")
async def list_tools(user: User = Depends(get_authenticated_user)):
    """List all available tools grouped by source.

    Returns MCP tools (flat + grouped by server) and built-in native tools.
    """
    try:
        orchestrator = get_user_orchestrator(user.id)

        # Flat MCP tools list (cached, reliable)
        mcp_tools = []
        try:
            mcp_tools = await orchestrator.get_tools()
        except Exception as e:
            logger.warning(f"Failed to get MCP tools: {e}")

        # Group MCP tools by server name using prefix matching
        mcp_servers = {}
        if mcp_tools:
            server_names = orchestrator.get_server_names()
            if len(server_names) == 1:
                mcp_servers = {server_names[0]: mcp_tools}
            elif server_names:
                mcp_servers = {name: [] for name in server_names}
                for tool in mcp_tools:
                    tool_name = tool.get("function", {}).get("name", "")
                    for name in server_names:
                        if tool_name.startswith(f"{name}_"):
                            mcp_servers[name].append(tool)
                            break
                # Remove empty groups
                mcp_servers = {k: v for k, v in mcp_servers.items() if v}

        # Get native tools with built_in flag
        native_tools = tool_registry.get_native_tool_info()

        return {
            "mcp_tools": mcp_tools,
            "builtin_tools": native_tools,
            "mcp_servers": mcp_servers,
        }
    except Exception as e:
        logger.error(f"Failed to list tools: {e}", exc_info=True)
        raise
