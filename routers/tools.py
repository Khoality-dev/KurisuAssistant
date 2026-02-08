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

        # Get built-in tools (all schemas without filtering)
        builtin_tools = tool_registry.get_schemas()

        # Filter out MCP tools from builtin_tools (they're already in mcp_tools)
        mcp_tool_names = {
            tool.get("function", {}).get("name")
            for tool in mcp_tools
        }
        builtin_tools = [
            tool for tool in builtin_tools
            if tool.get("function", {}).get("name") not in mcp_tool_names
        ]

        return {
            "mcp_tools": mcp_tools,
            "builtin_tools": builtin_tools,
        }
    except Exception as e:
        logger.error(f"Failed to list tools: {e}", exc_info=True)
        raise
