"""Repository for Device model operations."""

from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session

from ..models import Device
from .base import BaseRepository


class DeviceRepository(BaseRepository[Device]):
    """Repository for Device model operations."""

    def __init__(self, session: Session):
        super().__init__(Device, session)

    def get_by_user_and_hostname(self, user_id: int, hostname: str) -> Optional[Device]:
        return self.get_by_filter(user_id=user_id, hostname=hostname)

    def get_by_user(self, user_id: int) -> List[Device]:
        return self.get_many_by_filter(user_id=user_id)

    def get_by_user_and_id(self, user_id: int, device_id: int) -> Optional[Device]:
        return self.get_by_filter(user_id=user_id, id=device_id)

    def get_or_create(self, user_id: int, hostname: str, platform: str) -> Device:
        device = self.get_by_user_and_hostname(user_id, hostname)
        if device:
            self.update(device, platform=platform, last_seen=datetime.utcnow())
            return device
        return self.create(
            user_id=user_id,
            name=hostname,
            hostname=hostname,
            platform=platform,
        )
