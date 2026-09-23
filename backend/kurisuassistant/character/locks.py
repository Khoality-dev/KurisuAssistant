"""One lock per persona, held across "commit a config, then touch its files".

Every write that changes which files a persona's directory should hold commits
the row first and moves bytes second: a config save commits and then sweeps
what the committed config no longer names; a model or clip upload commits its
ref and then moves the file into place; a delete commits and then unlinks. On
the single database thread each commit is atomic, but the disk step after it is
not — and a config save that committed *before* an upload's ref would, left to
itself, sweep the model that upload moves into place a moment later, because
the reference set it computed at commit time does not include it.

Holding this lock from the commit through the disk step makes each of those
pairs atomic with respect to the others, so a sweep always runs against the
refs the row held when its own commit happened, and no upload can land in
between. Streaming the body happens *outside* it — an upload of 100 MB must not
hold up an autosave for the length of the transfer.

In-process: the API runs as one uvicorn process (``docker-entrypoint.sh``
starts no workers). A second process would need a lock the processes share.
"""

import asyncio
from weakref import WeakValueDictionary

_locks: "WeakValueDictionary[int, asyncio.Lock]" = WeakValueDictionary()


def persona_lock(persona_id: int) -> asyncio.Lock:
    """The lock for one persona's asset directory; the same object while anyone holds it."""
    lock = _locks.get(persona_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[persona_id] = lock
    return lock
