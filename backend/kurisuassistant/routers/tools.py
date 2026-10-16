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
    """Every tool the server offers the assistant, grouped by source.

    The server's own tools and the user's server-side MCP tools (flat and grouped
    by server), each with ``read_only``: whether it only looks, which is what the
    Read only permission mode runs (#360). A connected client's own tools are not
    the server's to list; the client shows those itself.
    """
    try:
        orchestrator = get_user_orchestrator(user.id)

        # Flat MCP tools list (cached, reliable)
        mcp_tools = []
        mcp_servers = {}
        try:
            mark = lambda t: {**t, "read_only": orchestrator.is_read_only(t.get("function", {}).get("name", ""))}
            mcp_tools = [mark(t) for t in await orchestrator.get_tools()]
            mcp_servers = {name: [mark(t) for t in tools] for name, tools in orchestrator.get_tools_by_server().items()}
        except Exception as e:
            logger.warning(f"Failed to get MCP tools: {e}")

        # The server's own tools, each saying whether it only looks (#360)
        native_tools = tool_registry.get_native_tool_info()

        return {
            "mcp_tools": mcp_tools,
            "server_tools": native_tools,
            "mcp_servers": mcp_servers,
        }
    except Exception as e:
        logger.error(f"Failed to list tools: {e}", exc_info=True)
        raise
