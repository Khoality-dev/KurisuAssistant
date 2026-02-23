"""Repository for MCPServer model operations."""

from typing import Optional, List
from sqlalchemy.orm import Session

from ..models import MCPServer
from .base import BaseRepository


class MCPServerRepository(BaseRepository[MCPServer]):
    """Repository for MCPServer model operations."""

    def __init__(self, session: Session):
        super().__init__(MCPServer, session)

    def list_by_user(self, user_id: int) -> List[MCPServer]:
        return (
            self.session.query(MCPServer)
            .filter_by(user_id=user_id)
            .order_by(MCPServer.created_at)
            .all()
        )

    def list_enabled_by_user(self, user_id: int) -> List[MCPServer]:
        return (
            self.session.query(MCPServer)
            .filter_by(user_id=user_id, enabled=True)
            .order_by(MCPServer.created_at)
            .all()
        )

    def get_by_user_and_id(self, user_id: int, server_id: int) -> Optional[MCPServer]:
        return self.get_by_filter(user_id=user_id, id=server_id)

    def create_server(
        self,
        user_id: int,
        name: str,
        transport_type: str,
        url: Optional[str] = None,
        command: Optional[str] = None,
        args: Optional[list] = None,
        env: Optional[dict] = None,
    ) -> MCPServer:
        existing = self.get_by_filter(user_id=user_id, name=name)
        if existing:
            raise ValueError(f"MCP server '{name}' already exists")
        return self.create(
            user_id=user_id,
            name=name,
            transport_type=transport_type,
            url=url,
            command=command,
            args=args,
            env=env,
        )

    def update_server(
        self,
        server: MCPServer,
        name: Optional[str] = None,
        transport_type: Optional[str] = None,
        url: Optional[str] = None,
        command: Optional[str] = None,
        args: Optional[list] = None,
        env: Optional[dict] = None,
        enabled: Optional[bool] = None,
    ) -> MCPServer:
        update_data = {}
        if name is not None:
            update_data["name"] = name
        if transport_type is not None:
            update_data["transport_type"] = transport_type
        if url is not None:
            update_data["url"] = url
        if command is not None:
            update_data["command"] = command
        if args is not None:
            update_data["args"] = args
        if env is not None:
            update_data["env"] = env
        if enabled is not None:
            update_data["enabled"] = enabled
        if update_data:
            return self.update(server, **update_data)
        return server

    def delete_by_user_and_id(self, user_id: int, server_id: int) -> bool:
        return self.delete_by_filter(user_id=user_id, id=server_id) > 0
