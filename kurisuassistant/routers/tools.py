"""Tools management router."""

import logging
from fastapi import APIRouter, Depends

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.models import User
from kurisuassistant.tools.registry import tool_registry
from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator

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
        mcp_servers = {}
        try:
            mcp_tools = await orchestrator.get_tools()
            mcp_servers = orchestrator.get_tools_by_server()
        except Exception as e:
            logger.warning(f"Failed to get MCP tools: {e}")

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
