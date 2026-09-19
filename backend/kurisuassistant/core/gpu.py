"""What the GPU has left.

A few bytes read from the driver, not a model: ``torch.cuda.mem_get_info``
reports the free and total memory of a device, and the import is lazy so a
CPU-only deployment — or one whose API container was given no GPU — pays
nothing and simply reports that it cannot see a card.

The number is the *whole* card, not this process's share. That is the point:
speech shares it with the vision pipeline and with whatever LLM host is
resident, and those are exactly the neighbours that decide whether an engine
fits (#221).
"""

import logging

logger = logging.getLogger(__name__)

_warned = False


def free_and_total() -> tuple[int, int] | None:
    """``(free, total)`` bytes on device 0, or ``None`` when there is no card
    this process can see. Never raises."""
    global _warned
    try:
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("no CUDA device visible to this process")
        return torch.cuda.mem_get_info(0)
    except Exception as e:  # noqa: BLE001 — a missing GPU is a configuration, not a fault
        if not _warned:
            logger.info("GPU memory is not readable here (%s); anything that depends on it is off", e)
            _warned = True
        return None


def free_bytes() -> int | None:
    """Free VRAM in bytes, or ``None`` when no card is visible."""
    reading = free_and_total()
    return reading[0] if reading else None
