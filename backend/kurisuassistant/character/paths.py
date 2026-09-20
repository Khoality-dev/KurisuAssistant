"""Where character assets live, and which path segments a request may name.

``CHAR_ASSETS_DIR`` is read as a module attribute at call time, never bound with
``from ... import``: it is the one name a test patches to point the whole store
at a temporary directory, and a copy taken at import would keep deleting under
the real ``data/``. Nothing here creates the directory — it is created when the
first file is written, so importing the package touches no disk.
"""

from pathlib import Path

from fastapi import HTTPException

from kurisuassistant.core.paths import DATA_DIR

CHAR_ASSETS_DIR = DATA_DIR / "character_assets"

# Directory names under a persona that are not pose ids: the edge videos, the
# staging area for streamed uploads, and the two the VRM store will use. A pose
# or edge named after one of these would either shadow a route or be swept as
# somebody else's files.
RESERVED_SEGMENTS = frozenset({"vrm", "vrma", "edges", ".incoming"})

# Uploads in flight; never walked by cleanup.
INCOMING_DIR_NAME = ".incoming"


def persona_dir(persona_id: int) -> Path:
    """The directory holding everything one persona owns."""
    return CHAR_ASSETS_DIR / str(persona_id)


def safe_segment(value: str, name: str) -> str:
    """Refuse a request parameter that could name anything but one file or folder.

    Every id and file name in this router is joined straight onto a disk path.
    Starlette percent-decodes path parameters, so ``%2e%2e`` arrives here as
    ``..``; a separator, a NUL or an empty string would do the same kind of damage
    in other ways. The check is the same on upload and on serve so the two can
    never disagree about what a name is.
    """
    if (
        not value
        or "/" in value
        or "\\" in value
        or "\x00" in value
        or value in (".", "..")
        or value in RESERVED_SEGMENTS
    ):
        raise HTTPException(status_code=400, detail=f"Invalid {name}.")
    return value
