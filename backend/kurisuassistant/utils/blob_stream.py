"""Streaming a request body to disk, bounded as it arrives.

Two stores take uploads too large to read into memory — Kurisu Drive and the
character store's VRM models and clips — and both need the same three things:
a write that stops the moment a ceiling is crossed, a temporary file that never
survives a failure (a client hanging up arrives as a cancellation, not an
exception), and a sweep for the part-files a killed process leaves behind. They
live here once. What each store does with the finished file — its own paths,
its own quota, its own error wording — stays with the store.
"""

import logging
from hashlib import sha256
from pathlib import Path
from time import time
from typing import AsyncIterator, Callable, Tuple

import anyio

logger = logging.getLogger(__name__)

#: How long a part-file may sit in an ``.incoming`` directory before it is
#: assumed abandoned. Comfortably longer than any upload the ceilings allow.
INCOMING_MAX_AGE_SECONDS = 24 * 60 * 60


async def write_stream(
    dest_tmp: Path,
    chunks: AsyncIterator[bytes],
    max_bytes: int,
    quota_remaining: int,
    too_large: Callable[[], BaseException],
    over_quota: Callable[[], BaseException],
) -> Tuple[int, str]:
    """Write ``chunks`` to ``dest_tmp``; return ``(size, sha256_hex)``.

    Raises ``too_large()`` once more than ``max_bytes`` have arrived and
    ``over_quota()`` once more than ``quota_remaining`` have — as the bytes
    arrive, not after they are all on disk. On any failure, including a
    cancellation, ``dest_tmp`` is unlinked before the exception propagates; on
    success it is the caller's to move into place.
    """
    await anyio.to_thread.run_sync(lambda: dest_tmp.parent.mkdir(parents=True, exist_ok=True))
    digest = sha256()
    size = 0
    try:
        handle = await anyio.to_thread.run_sync(lambda: open(dest_tmp, "wb"))
        try:
            async for chunk in chunks:
                if not chunk:
                    continue
                size += len(chunk)
                if size > max_bytes:
                    raise too_large()
                if size > quota_remaining:
                    raise over_quota()
                digest.update(chunk)
                await anyio.to_thread.run_sync(handle.write, chunk)
        finally:
            await anyio.to_thread.run_sync(handle.close)
        return size, digest.hexdigest()
    except BaseException:
        await anyio.to_thread.run_sync(lambda: dest_tmp.unlink(missing_ok=True))
        raise


def sweep_incoming(incoming: Path) -> None:
    """Remove part-files nothing is writing any more.

    ``write_stream`` unlinks its own temp file on every exception, including a
    client hanging up — but not when the process is killed outright. Those
    orphans count against no quota (both stores meter what their rows or refs
    record, not what is on disk), and no cleanup walk ever enters ``.incoming``.
    Sweeping before each upload rather than on a schedule keeps it self-healing
    and costs one listdir of a directory that is normally empty.
    """
    cutoff = time() - INCOMING_MAX_AGE_SECONDS
    try:
        entries = list(incoming.iterdir())
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
        except OSError:
            # Another request may be mid-upload into it; leave it alone.
            continue
