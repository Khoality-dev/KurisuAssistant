"""MCP server CRUD routes."""

import logging
from typing import Optional, List, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import MCPServerRepository
from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator, invalidate_user_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp-servers", tags=["mcp"])


class MCPServerCreate(BaseModel):
    name: str
    transport_type: str
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None
    location: Optional[str] = "server"

    @field_validator("transport_type")
    @classmethod
    def validate_transport_type(cls, v: str) -> str:
        if v not in ("sse", "stdio"):
            raise ValueError("transport_type must be 'sse' or 'stdio'")
        return v

    @field_validator("location")
    @classmethod
    def validate_location(cls, v: Optional[str]) -> str:
        if v is not None and v not in ("server", "client"):
            raise ValueError("location must be 'server' or 'client'")
        return v or "server"


class MCPServerUpdate(BaseModel):
    name: Optional[str] = None
    transport_type: Optional[str] = None
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None
    enabled: Optional[bool] = None
    location: Optional[str] = None

    @field_validator("transport_type")
    @classmethod
    def validate_transport_type(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("sse", "stdio"):
            raise ValueError("transport_type must be 'sse' or 'stdio'")
        return v

    @field_validator("location")
    @classmethod
    def validate_location(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("server", "client"):
            raise ValueError("location must be 'server' or 'client'")
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
        "location": server.location or "server",
        "created_at": server.created_at.isoformat() + "Z" if server.created_at else None,
    }


@router.get("")
async def list_mcp_servers(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """List all MCP servers for the current user."""
    try:
        db = get_db_service()
        return await db.execute(lambda s: [_serialize(srv) for srv in MCPServerRepository(s).list_by_user(user.id)])
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
        def _create(session):
            repo = MCPServerRepository(session)
            server = repo.create_server(
                user_id=user.id,
                name=data.name,
                transport_type=data.transport_type,
                url=data.url,
                command=data.command,
                args=data.args,
                env=data.env,
                location=data.location,
            )
            return _serialize(server)

        db = get_db_service()
        result = await db.execute(_create)
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
        def _update(session):
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
                location=data.location,
            )
            return _serialize(server)

        db = get_db_service()
        result = await db.execute(_update)
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
        def _delete(session):
            repo = MCPServerRepository(session)
            deleted = repo.delete_by_user_and_id(user.id, server_id)
            if not deleted:
                raise HTTPException(status_code=404, detail="MCP server not found")
            return True

        db = get_db_service()
        await db.execute(_delete)
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
        def _fetch_server(session):
            repo = MCPServerRepository(session)
            server = repo.get_by_user_and_id(user.id, server_id)
            if not server:
                raise HTTPException(status_code=404, detail="MCP server not found")
            return _serialize(server)

        db = get_db_service()
        server_data = await db.execute(_fetch_server)

        # Client-side servers can't be tested from the backend
        if server_data.get("location") == "client":
            return {"status": "unavailable", "error": "Client-side servers are tested from the desktop app"}

        # Build a temporary config and try listing tools
        from mcp_tools.client import list_tools
        from types import SimpleNamespace

        # _create_client_from_server expects an object with attributes
        server_obj = SimpleNamespace(**server_data)

        from mcp_tools.orchestrator import _create_client_from_server
        client = _create_client_from_server(server_obj)
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
