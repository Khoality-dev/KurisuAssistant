"""Version handshake endpoint."""

from fastapi import APIRouter

from kurisuassistant.version import WIRE_PROTOCOL, __version__

router = APIRouter(tags=["health"])


@router.get("/version")
async def get_version():
    """Return backend version + wire-protocol integer.

    Clients must call this on startup and refuse to operate when their own
    `WIRE_PROTOCOL` constant does not equal the value returned here.
    """
    return {
        "backend_version": __version__,
        "wire_protocol": WIRE_PROTOCOL,
    }
