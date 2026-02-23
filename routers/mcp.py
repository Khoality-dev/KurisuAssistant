"""MCP server CRUD routes."""

import logging
from typing import Optional, List, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import MCPServerRepository
from mcp_tools.orchestrator import get_user_orchestrator, invalidate_user_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp-servers", tags=["mcp"])


class MCPServerCreate(BaseModel):
    name: str
    transport_type: str
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None

    @field_validator("transport_type")
    @classmethod
    def validate_transport_type(cls, v: str) -> str:
        if v not in ("sse", "stdio"):
            raise ValueError("transport_type must be 'sse' or 'stdio'")
        return v


class MCPServerUpdate(BaseModel):
    name: Optional[str] = None
    transport_type: Optional[str] = None
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None
    enabled: Optional[bool] = None

    @field_validator("transport_type")
    @classmethod
    def validate_transport_type(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("sse", "stdio"):
            raise ValueError("transport_type must be 'sse' or 'stdio'")
        return v


def _serialize(server) -> dict:
    return {
        "id": server.id,
        "name": server.name,
        "transport_type": server.transport_type,
        "url": server.url,
        "command": server.command,
        "args": server.args,
        "env": server.env,
        "enabled": server.enabled,
        "created_at": server.created_at.isoformat() + "Z" if server.created_at else None,
    }


@router.get("")
async def list_mcp_servers(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """List all MCP servers for the current user."""
    try:
        with get_session() as session:
            repo = MCPServerRepository(session)
            servers = repo.list_by_user(user.id)
            return [_serialize(s) for s in servers]
    except Exception as e:
        logger.error(f"Error listing MCP servers: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("")
async def create_mcp_server(
    data: MCPServerCreate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Create a new MCP server."""
    try:
        with get_session() as session:
            repo = MCPServerRepository(session)
            server = repo.create_server(
                user_id=user.id,
                name=data.name,
                transport_type=data.transport_type,
                url=data.url,
                command=data.command,
                args=data.args,
                env=data.env,
            )
            result = _serialize(server)
        invalidate_user_orchestrator(user.id)
        return result
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating MCP server: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{server_id}")
async def update_mcp_server(
    server_id: int,
    data: MCPServerUpdate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Update an MCP server."""
    try:
        with get_session() as session:
            repo = MCPServerRepository(session)
            server = repo.get_by_user_and_id(user.id, server_id)
            if not server:
                raise HTTPException(status_code=404, detail="MCP server not found")

            server = repo.update_server(
                server,
                name=data.name,
                transport_type=data.transport_type,
                url=data.url,
                command=data.command,
                args=data.args,
                env=data.env,
                enabled=data.enabled,
            )
            result = _serialize(server)
        invalidate_user_orchestrator(user.id)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating MCP server: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{server_id}")
async def delete_mcp_server(
    server_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete an MCP server."""
    try:
        with get_session() as session:
            repo = MCPServerRepository(session)
            deleted = repo.delete_by_user_and_id(user.id, server_id)
            if not deleted:
                raise HTTPException(status_code=404, detail="MCP server not found")
        invalidate_user_orchestrator(user.id)
        return {"deleted": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting MCP server: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{server_id}/test")
async def test_mcp_server(
    server_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Test connectivity to an MCP server by listing its tools."""
    try:
        with get_session() as session:
            repo = MCPServerRepository(session)
            server = repo.get_by_user_and_id(user.id, server_id)
            if not server:
                raise HTTPException(status_code=404, detail="MCP server not found")

            # Build a temporary config and try listing tools
            from mcp_tools.orchestrator import _create_client_from_server
            from mcp_tools.client import list_tools

            client = _create_client_from_server(server)
            if client is None:
                return {"status": "unavailable", "error": "Could not create client"}

            try:
                tools = await list_tools(client)
                return {"status": "available", "tool_count": len(tools)}
            except Exception as e:
                return {"status": "unavailable", "error": str(e)}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error testing MCP server: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
