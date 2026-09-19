"""Which speech engines are holding the GPU, and which have to give it back.

Every engine is a container now (#212), so residency is a container decision:
an engine that is up holds its weights until it is stopped. This offloads on
**pressure, not on a timer** (#221) — a warm engine costs nothing while the card
has room, so it stays warm, and it is stopped only when something else needs
the memory.

Before a request reaches an engine that is not running, the free VRAM is read
and, if the engine will not fit, the least recently used engines are stopped
until it does. An engine serving a request is never stopped, however tight
things get: `in_use` is checked again inside the critical section, so a request
that arrives while a decision is being made always wins.

Each engine's footprint is **measured, not configured**: the free memory is read
before an engine is started and again once the first request through it has
finished loading its models, and the difference is what that engine costs. The
configured estimate is only the first guess, used until the real number is
known.

**The clients know nothing about any of this.** No event, no field, no protocol
change. A request either comes back with audio or with the failure sentence the
clients already handle; whether it waited for a container start is the server's
business, and everything worth seeing goes to this log.

Off unless configured: with no Docker proxy (`SPEECH_DOCKER_URL`), no container
named for the engine (`SPEECH_CONTAINERS`) or no readable GPU, `serving` is a
passthrough and engines are left exactly as the operator started them.
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from fastapi import HTTPException

from kurisuassistant.core.gpu import free_bytes
from kurisuassistant.speech import containers
from kurisuassistant.speech.engines.base import UNAVAILABLE

logger = logging.getLogger(__name__)

MB = 1024 * 1024


def _setting(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        logger.warning("%s is not a number; using %s", name, default)
        return default


def headroom_bytes() -> int:
    """Margin left free so a fit is a real fit, not a rounding error."""
    return int(_setting("SPEECH_VRAM_HEADROOM_MB", 512) * MB)


def first_guess_bytes() -> int:
    """What an engine is assumed to cost before it has ever been measured."""
    return int(_setting("SPEECH_DEFAULT_FOOTPRINT_MB", 2500) * MB)


def start_timeout() -> float:
    """How long a request waits for an engine to come up before giving up."""
    return _setting("SPEECH_START_TIMEOUT_SECONDS", 120)


@dataclass
class _Entry:
    model_id: str
    container: str
    in_use: int = 0
    last_used: float = field(default_factory=time.monotonic)
    #: Measured bytes this engine holds on the card; None until it is known.
    footprint: int | None = None

    def need(self) -> int:
        return self.footprint if self.footprint is not None else first_guess_bytes()


class Residency:
    def __init__(self):
        self._entries: dict[str, _Entry] = {}
        self._lock = asyncio.Lock()

    # --- the guard a request goes through --------------------------------

    @asynccontextmanager
    async def serving(self, engine):
        """Make ``engine`` available, and hold it there for the block.

        A passthrough when residency is not configured for this engine.
        """
        container = containers.container_for(engine.model_id)
        if not container or not containers.proxy_url():
            yield
            return

        entry = self._entries.setdefault(
            engine.model_id, _Entry(engine.model_id, container),
        )
        free_before = await self._make_available(engine, entry)
        async with self._lock:
            entry.in_use += 1
        try:
            yield
        finally:
            async with self._lock:
                entry.in_use -= 1
                entry.last_used = time.monotonic()
            if free_before is not None:
                await self._measure(entry, free_before)

    # --- making room ------------------------------------------------------

    async def _make_available(self, engine, entry: _Entry) -> int | None:
        """Ensure the container is up, evicting by LRU if the card is too full.

        Returns the free VRAM read just before a start, so the caller can
        measure this engine's footprint once the request has warmed it — or
        ``None`` when nothing was started and there is nothing to measure.
        """
        async with self._lock:
            try:
                if await containers.is_running(entry.container):
                    return None
            except containers.DockerUnavailable as e:
                # The proxy is the optional half. An engine that is already
                # running keeps working; one that is down stays down and the
                # request fails on its own, with the usual sentence.
                logger.warning("residency: cannot reach the Docker proxy (%s); leaving engines alone", e)
                return None

            free = free_bytes()
            if free is not None:
                await self._evict_until(entry, need=entry.need() + headroom_bytes(), free=free)

            await containers.start(entry.container)

        await self._wait_until_answering(engine, entry)
        return free

    async def _evict_until(self, incoming: _Entry, need: int, free: int) -> None:
        """Stop least-recently-used engines until ``need`` bytes are free.

        Called with the lock held. An engine in use is never a candidate; if
        the idle ones are not enough the start is attempted anyway, because a
        measured guess may be pessimistic and the engine's own failure is a
        better answer than refusing to try.
        """
        if free >= need:
            return
        candidates = [
            e for e in self._entries.values()
            if e is not incoming and e.in_use == 0 and e.footprint is not None
        ]
        candidates.sort(key=lambda e: e.last_used)
        for victim in candidates:
            if free >= need:
                return
            try:
                if not await containers.is_running(victim.container):
                    continue
                await containers.stop(victim.container)
            except containers.DockerUnavailable as e:
                logger.warning("residency: could not stop %s: %s", victim.container, e)
                continue
            logger.info(
                "residency: evicted %s to make room for %s (idle %ds, held %dMB)",
                victim.model_id, incoming.model_id,
                int(time.monotonic() - victim.last_used), (victim.footprint or 0) // MB,
            )
            reading = free_bytes()
            free = reading if reading is not None else free + (victim.footprint or 0)
        if free < need:
            logger.warning(
                "residency: %dMB free, %s wants %dMB and nothing else can be evicted; starting anyway",
                free // MB, incoming.model_id, need // MB,
            )

    async def _wait_until_answering(self, engine, entry: _Entry) -> None:
        """Block until the engine answers, or fail the request the usual way."""
        deadline = time.monotonic() + start_timeout()
        attempt = 0
        while time.monotonic() < deadline:
            health = await engine.healthy()
            if health.get("ok"):
                logger.info("residency: %s is answering after %.0fs",
                            entry.model_id, start_timeout() - (deadline - time.monotonic()))
                return
            attempt += 1
            await asyncio.sleep(min(2 + attempt, 5))
        logger.error("residency: %s did not answer within %.0fs of starting %s",
                     entry.model_id, start_timeout(), entry.container)
        raise HTTPException(status_code=502, detail=UNAVAILABLE)

    # --- learning what an engine costs ------------------------------------

    async def _measure(self, entry: _Entry, free_before: int) -> None:
        """What this engine took, once a request has made it load its models."""
        free_now = free_bytes()
        if free_now is None:
            return
        held = free_before - free_now
        if held <= 0:
            # Something else freed memory in the meantime; a negative reading
            # says nothing about this engine, so keep the previous belief.
            return
        previous = entry.footprint
        entry.footprint = held if previous is None else max(previous, held)
        if entry.footprint != previous:
            logger.info("residency: %s holds about %dMB", entry.model_id, entry.footprint // MB)

    # --- what an operator can see -----------------------------------------

    def status(self) -> dict:
        now = time.monotonic()
        free = free_bytes()
        return {
            "gpu_free_mb": free // MB if free is not None else None,
            "engines": {
                e.model_id: {
                    "container": e.container,
                    "in_use": e.in_use,
                    "idle_seconds": 0 if e.in_use else int(now - e.last_used),
                    "holds_mb": e.footprint // MB if e.footprint is not None else None,
                }
                for e in self._entries.values()
            },
        }


residency = Residency()
