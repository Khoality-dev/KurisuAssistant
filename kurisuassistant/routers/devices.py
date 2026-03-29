"""Device CRUD routes."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import DeviceRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/devices", tags=["devices"])


class DeviceUpdate(BaseModel):
    name: Optional[str] = None


@router.get("")
async def list_devices(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """List all registered devices for the current user."""
    try:
        def _list(session):
            repo = DeviceRepository(session)
            devices = repo.get_by_user(user.id)
            return [
                {
                    "id": d.id,
                    "name": d.name,
                    "hostname": d.hostname,
                    "platform": d.platform,
                    "last_seen": d.last_seen.isoformat() + "Z" if d.last_seen else None,
                    "created_at": d.created_at.isoformat() + "Z" if d.created_at else None,
                }
                for d in devices
            ]

        db = get_db_service()
        return await db.execute(_list)
    except Exception as e:
        logger.error(f"Error listing devices: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{device_id}")
async def update_device(
    device_id: int,
    data: DeviceUpdate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Update a device (rename)."""
    try:
        def _update(session):
            repo = DeviceRepository(session)
            device = repo.get_by_user_and_id(user.id, device_id)
            if not device:
                raise HTTPException(status_code=404, detail="Device not found")
            if data.name is not None:
                repo.update(device, name=data.name)
            return {
                "id": device.id,
                "name": device.name,
                "hostname": device.hostname,
                "platform": device.platform,
                "last_seen": device.last_seen.isoformat() + "Z" if device.last_seen else None,
                "created_at": device.created_at.isoformat() + "Z" if device.created_at else None,
            }

        db = get_db_service()
        return await db.execute(_update)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating device: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{device_id}")
async def delete_device(
    device_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete a device."""
    try:
        def _delete(session):
            repo = DeviceRepository(session)
            device = repo.get_by_user_and_id(user.id, device_id)
            if not device:
                raise HTTPException(status_code=404, detail="Device not found")
            repo.delete(device)
            return True

        db = get_db_service()
        await db.execute(_delete)
        return {"deleted": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting device: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
