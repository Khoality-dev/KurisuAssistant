"""Residency: which models are on the GPU, which are parked in CPU memory, and
which are gone (#207).

One process now holds every speech model, on a GPU it shares with other things,
so a model that nobody is using should not sit on it. Each registered model is
in one of three states — ``resident`` (weights on the device), ``offloaded``
(weights in CPU memory, seconds to bring back), ``unloaded`` (nothing in
memory, tens of seconds to bring back) — and moves between them under three
rules:

- a request brings its model to ``resident`` and holds it there until it
  returns; a model in use is never parked;
- at most ``max_resident_tts`` synthesis models are resident at once — bringing
  another one in parks the least recently used one first;
- the sweeper parks a model idle for ``offload_after`` seconds and drops one
  idle for ``unload_after`` seconds. A model that cannot offload (VieNeu's ONNX
  sessions, CTranslate2's Whisper) stays resident until the unload threshold.

The scheduler knows nothing about tensors. A model is anything with
``model_id``, ``load()`` (idempotent; also brings an offloaded model back),
``offload() -> bool`` (False when unsupported) and ``unload()``. The heavy calls
run outside the scheduler's lock, serialised per model by ``_Entry.op_lock``,
and the in-use check is repeated under that lock so a request that arrives
while the sweeper is deciding always wins.
"""

import logging
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

logger = logging.getLogger(__name__)

UNLOADED = "unloaded"
OFFLOADED = "offloaded"
RESIDENT = "resident"


@dataclass
class _Entry:
    model: Any
    kind: str  # "tts" or "asr"
    state: str = UNLOADED
    last_used: float = 0.0
    in_use: int = 0
    op_lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def key(self) -> str:
        return f"{self.kind}:{self.model.model_id}"


class ModelScheduler:
    def __init__(
        self,
        *,
        max_resident_tts: int = 1,
        offload_after: float = 300.0,
        unload_after: float = 1800.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        # 0 means no cap / never.
        self.max_resident_tts = max_resident_tts
        self.offload_after = offload_after
        self.unload_after = unload_after
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}

    # --- registration ----------------------------------------------------

    def register(self, model: Any, kind: str = "tts") -> _Entry:
        key = f"{kind}:{model.model_id}"
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = _Entry(model=model, kind=kind, last_used=self._clock())
                self._entries[key] = entry
            return entry

    # --- use ------------------------------------------------------------

    @contextmanager
    def use(self, model: Any, kind: str = "tts") -> Iterator[Any]:
        """Bring ``model`` to residency and hold it there for the block."""
        entry = self.register(model, kind)
        with self._lock:
            entry.in_use += 1
            victims = self._make_room(entry) if entry.kind == "tts" and entry.state != RESIDENT else []
        try:
            for victim in victims:
                self._park(victim, drop=False, reason=f"room for {entry.model.model_id}")
            self._bring(entry)
            yield entry.model
        finally:
            with self._lock:
                entry.in_use -= 1
                entry.last_used = self._clock()

    def preload(self, model: Any, kind: str = "tts") -> None:
        with self.use(model, kind):
            pass

    def _make_room(self, incoming: _Entry) -> list[_Entry]:
        """Called with the lock held. The LRU resident synthesis models that
        have to leave for ``incoming`` to fit under the cap; never one in use."""
        if self.max_resident_tts <= 0:
            return []
        resident = [
            e for e in self._entries.values()
            if e.kind == "tts" and e.state == RESIDENT and e is not incoming
        ]
        excess = len(resident) + 1 - self.max_resident_tts
        if excess <= 0:
            return []
        idle = sorted((e for e in resident if e.in_use == 0), key=lambda e: e.last_used)
        return idle[:excess]

    def _bring(self, entry: _Entry) -> None:
        with entry.op_lock:
            with self._lock:
                already = entry.state == RESIDENT
            if already:
                return
            entry.model.load()
            with self._lock:
                entry.state = RESIDENT
            logger.info("residency: %s resident", entry.key)

    def _park(self, entry: _Entry, *, drop: bool, reason: str) -> None:
        """Offload (or, with ``drop``, unload) unless it is in use — checked again
        under the model's op lock, so a request that got there first wins."""
        with entry.op_lock:
            with self._lock:
                if entry.in_use or entry.state == UNLOADED or (not drop and entry.state != RESIDENT):
                    return
            if drop:
                entry.model.unload()
                new_state = UNLOADED
            else:
                if not entry.model.offload():
                    return
                new_state = OFFLOADED
            with self._lock:
                entry.state = new_state
            logger.info("residency: %s %s (%s)", entry.key, new_state, reason)

    # --- the sweeper ----------------------------------------------------

    def sweep(self) -> None:
        now = self._clock()
        with self._lock:
            snapshot = [(e, now - e.last_used) for e in self._entries.values() if e.in_use == 0]
        for entry, idle in snapshot:
            if self.unload_after > 0 and idle >= self.unload_after and entry.state != UNLOADED:
                self._park(entry, drop=True, reason=f"idle {int(idle)}s")
            elif self.offload_after > 0 and idle >= self.offload_after and entry.state == RESIDENT:
                self._park(entry, drop=False, reason=f"idle {int(idle)}s")

    def run_forever(self, interval: float = 15.0) -> None:
        while True:
            time.sleep(interval)
            try:
                self.sweep()
            except Exception:  # noqa: BLE001 — the sweeper must outlive one bad unload
                logger.exception("residency sweep failed")

    # --- reporting ------------------------------------------------------

    def status(self) -> dict[str, dict]:
        now = self._clock()
        with self._lock:
            return {
                e.key: {
                    "residency": e.state,
                    "idle_seconds": 0 if e.in_use else int(now - e.last_used),
                    "in_use": e.in_use,
                }
                for e in self._entries.values()
            }


def _from_config() -> ModelScheduler:
    from universal_voice import config

    return ModelScheduler(
        max_resident_tts=config.TTS_MAX_RESIDENT,
        offload_after=config.OFFLOAD_AFTER_SECONDS,
        unload_after=config.UNLOAD_AFTER_SECONDS,
    )


scheduler = _from_config()
