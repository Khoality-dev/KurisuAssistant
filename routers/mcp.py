"""MCP server management routes."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from mcp_tools.orchestrator import get_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mcp"])


@router.get("/mcp-servers")
async def mcp_servers(
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List configured MCP servers and their status."""
    try:
        orchestrator = get_orchestrator()
        configs = orchestrator.mcp_configs

        servers = []
        for name, config in configs.get("mcpServers", {}).items():
            server_info = {
                "name": name,
                "command": config.get("command", ""),
                "args": config.get("args", []),
                "url": config.get("url", ""),
                "status": "configured"
            }
            servers.append(server_info)

        # Check availability by attempting to list tools
        if orchestrator.mcp_client is not None:
            try:
                tools = await orchestrator.get_tools()
                status = "available" if tools else "unavailable"
                for server in servers:
                    server["status"] = status
            except Exception:
                pass

        return {"servers": servers}
    except Exception as e:
        logger.error(f"Error fetching MCP servers: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
