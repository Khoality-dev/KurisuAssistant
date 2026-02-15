"""Tools management router."""

import logging
from fastapi import APIRouter, Depends

from core.deps import get_authenticated_user
from db.models import User
from tools.registry import tool_registry
from mcp_tools.orchestrator import get_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("")
async def list_tools(user: User = Depends(get_authenticated_user)):
    """List all available tools (MCP + built-in).

    Returns both MCP tools from the orchestrator and built-in native tools
    from the tool registry.
    """
    try:
        # Get MCP tools
        orchestrator = get_orchestrator()
        mcp_tools = []
        if orchestrator:
            try:
                mcp_tools = await orchestrator.get_tools()
            except Exception as e:
                logger.warning(f"Failed to get MCP tools: {e}")

        # Get native tools with built_in flag
        native_tools = tool_registry.get_native_tool_info()

        return {
            "mcp_tools": mcp_tools,
            "builtin_tools": native_tools,
        }
    except Exception as e:
        logger.error(f"Failed to list tools: {e}", exc_info=True)
        raise
