"""Blob storage for Kurisu Drive.

Bytes live under ``data/drive/{user_id}/{storage_key}`` — a top-level subtree of
its own rather than a corner of ``image_storage``, because it is the one store
that grows without bound and an operator has to be able to archive or exclude it
on its own (``docs/operations.md``).

Two things here differ from ``utils/images.py`` on purpose:

* **Nothing is re-encoded.** A drive gives back the bytes it was given; that is
  the whole feature. The image store decodes and re-writes at JPEG quality 90.
* **Uploads stream.** Every existing ``UploadFile`` route reads the whole body
  into memory before it does anything, so the size ceiling is checked after the
  upload has already been paid for. Here the write is incremental and stops the
  moment the file or the account's quota is exceeded.

A filesystem path is only ever built from ``storage_key``, a UUID this module
generates. No name a user typed reaches the disk, so path traversal is not
something to sanitise — it is something that cannot be expressed.
"""

import logging
import mimetypes
import os
import uuid
from hashlib import sha256
from pathlib import Path
from typing import AsyncIterator, Optional, Tuple

import anyio
from fastapi import HTTPException

from kurisuassistant.core.paths import DATA_DIR

logger = logging.getLogger(__name__)

DRIVE_DIR = DATA_DIR / "drive"

#: Largest single file, in bytes. Streaming means this is enforced as the bytes
#: arrive rather than after they are all in memory.
MAX_FILE_BYTES = int(os.getenv("DRIVE_MAX_FILE_BYTES", str(2 * 1024 * 1024 * 1024)))

#: Total bytes one account may store. Registration is open by default, so an
#: unmetered drive would be a disk-exhaustion surface for the whole host.
QUOTA_BYTES = int(os.getenv("DRIVE_QUOTA_BYTES", str(15 * 1024 * 1024 * 1024)))

CHUNK_SIZE = 1024 * 1024

#: Everything else is served as an attachment. An uploaded ``.html`` rendered
#: inline would run on the API's own origin, with the caller's session behind it.
INLINE_SAFE_PREFIXES = ("image/", "audio/", "video/")
INLINE_SAFE_TYPES = frozenset({"application/pdf", "text/plain"})

#: Types the prefixes above would otherwise wave through. SVG is an image the
#: browser *executes*: it can carry ``<script>`` and inline event handlers, so
#: serving one inline is serving a page. It is the reason this list exists.
INLINE_UNSAFE_TYPES = frozenset({"image/svg+xml", "image/svg"})

DEFAULT_MIME = "application/octet-stream"

MAX_NAME_BYTES = 255


def validate_name(name: str) -> str:
    """Return ``name`` if it can be a drive entry's name, else raise 400.

    This guards the *database*, not the filesystem — blobs are named by UUID, so
    a bad name here cannot escape a directory. What it prevents is a name no
    client can render or navigate: a separator would make one entry look like
    two, and ``.``/``..`` would look like navigation in every UI that shows a
    path.
    """
    if not isinstance(name, str):
        raise HTTPException(status_code=400, detail="A name is required.")
    stripped = name.strip()
    if not stripped:
        raise HTTPException(status_code=400, detail="A name is required.")
    if stripped != name:
        raise HTTPException(
            status_code=400, detail="A name cannot start or end with a space."
        )
    if len(name.encode("utf-8")) > MAX_NAME_BYTES:
        raise HTTPException(
            status_code=400, detail=f"A name cannot be longer than {MAX_NAME_BYTES} bytes."
        )
    if "/" in name or "\\" in name:
        raise HTTPException(
            status_code=400, detail="A name cannot contain a slash or a null byte."
        )
    # Every control character, not just NUL. A name carrying CR or LF would end
    # up inside a Content-Disposition header on the way back out, and inside a
    # multipart part header on the way in — both places where a line break
    # starts a new header rather than being data. Clients escape it too; this is
    # the end that has to hold.
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise HTTPException(
            status_code=400, detail="A name cannot contain control characters."
        )
    if name in (".", ".."):
        raise HTTPException(status_code=400, detail="That name is reserved.")
    return name


def guess_mime(name: str) -> str:
    """Guess a type from the filename, never from what the client claimed.

    The declared content type is client-supplied and gates nothing; trusting it
    is how a store ends up serving ``text/html`` because someone said so.
    """
    guessed, _ = mimetypes.guess_type(name)
    return guessed or DEFAULT_MIME


def is_inline_safe(mime: Optional[str]) -> bool:
    """Whether this type may be served without ``Content-Disposition: attachment``."""
    if not mime:
        return False
    if mime in INLINE_UNSAFE_TYPES:
        return False
    if mime in INLINE_SAFE_TYPES:
        return True
    return any(mime.startswith(prefix) for prefix in INLINE_SAFE_PREFIXES)


def user_dir(user_id: int) -> Path:
    return DRIVE_DIR / str(user_id)


def blob_path(user_id: int, storage_key: str) -> Path:
    return user_dir(user_id) / storage_key


def blob_exists(user_id: int, storage_key: str) -> bool:
    return blob_path(user_id, storage_key).is_file()


async def store_stream(
    user_id: int,
    chunks: AsyncIterator[bytes],
    quota_remaining: int,
) -> Tuple[str, int, str]:
    """Write an incoming stream to a new blob.

    Returns ``(storage_key, size, sha256_hex)``.

    The bytes go to a temporary name first and are moved into place only once
    the whole stream has arrived, so a cancelled or refused upload never leaves
    a half-file that a row could later be pointed at. ``quota_remaining`` is the
    space this account still has; pass the file's current size back in when
    replacing one, since its bytes are about to be released.
    """
    incoming = user_dir(user_id) / ".incoming"
    await anyio.to_thread.run_sync(lambda: incoming.mkdir(parents=True, exist_ok=True))

    storage_key = uuid.uuid4().hex
    temp_path = incoming / storage_key
    digest = sha256()
    size = 0

    try:
        handle = await anyio.to_thread.run_sync(lambda: open(temp_path, "wb"))
        try:
            async for chunk in chunks:
                if not chunk:
                    continue
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "That file is larger than the "
                            f"{MAX_FILE_BYTES // (1024 * 1024)} MB limit."
                        ),
                    )
                if size > quota_remaining:
                    raise HTTPException(
                        status_code=507,
                        detail="Your drive is full. Remove something, or ask for more space.",
                    )
                digest.update(chunk)
                await anyio.to_thread.run_sync(handle.write, chunk)
        finally:
            await anyio.to_thread.run_sync(handle.close)

        final_path = blob_path(user_id, storage_key)
        await anyio.to_thread.run_sync(
            lambda: final_path.parent.mkdir(parents=True, exist_ok=True)
        )
        await anyio.to_thread.run_sync(os.replace, str(temp_path), str(final_path))
        return storage_key, size, digest.hexdigest()
    except BaseException:
        # Includes the client hanging up mid-upload, which arrives as a
        # cancellation rather than an exception the handler would catch.
        await anyio.to_thread.run_sync(lambda: temp_path.unlink(missing_ok=True))
        raise


async def read_text(user_id: int, storage_key: str, max_bytes: int) -> Tuple[str, bool]:
    """Read a blob as UTF-8 text, bounded. Returns ``(text, truncated)``.

    Raises ``ValueError`` when the bytes are not text — a binary file handed to
    a language model is noise that costs real context, so the tools refuse it
    rather than passing along replacement characters.
    """

    def _read() -> bytes:
        with open(blob_path(user_id, storage_key), "rb") as handle:
            return handle.read(max_bytes + 1)

    raw = await anyio.to_thread.run_sync(_read)
    truncated = len(raw) > max_bytes
    raw = raw[:max_bytes]
    if b"\0" in raw:
        raise ValueError("binary")
    try:
        return raw.decode("utf-8"), truncated
    except UnicodeDecodeError as exc:
        raise ValueError("binary") from exc


async def delete_blobs(user_id: int, storage_keys) -> None:
    """Unlink blobs whose rows are already gone.

    Called after the delete has committed. A failure here leaks disk but breaks
    nothing, so it is logged rather than raised — the alternative, failing the
    request, would tell the user their file is still there when the row is gone.
    """

    def _unlink() -> None:
        for key in storage_keys:
            if not key:
                continue
            try:
                blob_path(user_id, key).unlink(missing_ok=True)
            except OSError:
                logger.warning(
                    "drive: could not remove blob for user %s (key %s)", user_id, key,
                    exc_info=True,
                )

    await anyio.to_thread.run_sync(_unlink)
