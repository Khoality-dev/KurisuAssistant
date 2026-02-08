"""MCP server management routes."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mcp"])

# MCP client and configs are set from main.py
mcp_client = None
mcp_configs = {}


def set_mcp_client(client, configs):
    """Set MCP client and configs from main.py."""
    global mcp_client, mcp_configs
    mcp_client = client
    mcp_configs = configs


@router.get("/mcp-servers")
async def mcp_servers(
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List configured MCP servers and their status."""
    try:
        servers = []
        for name, config in mcp_configs.get("mcpServers", {}).items():
            server_info = {
                "name": name,
                "command": config.get("command", ""),
                "args": config.get("args", []),
                "status": "configured"
            }
            servers.append(server_info)

        # Try to get tools from each server to show availability
        if mcp_client is not None:
            try:
                from mcp_tools.client import list_tools
                tools = await list_tools(mcp_client)
                available_servers = set()
                for tool in tools:
                    server_name = tool.get("server", "unknown")
                    available_servers.add(server_name)

                for server in servers:
                    if server["name"] in available_servers:
                        server["status"] = "available"
                    else:
                        server["status"] = "unavailable"
            except Exception:
                pass

        return {"servers": servers}
    except Exception as e:
        logger.error(f"Error fetching MCP servers: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
