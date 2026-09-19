"""Which engines this deployment has, and which one serves a request.

An engine is configured by its address, and an address that is not set means
the operator did not start that engine. Nothing is discovered: the backend
knows what it was given, so a model listing costs no request and cannot come
back empty because something was briefly unreachable (#151).

  GPTSOVITS_URL   http://gpt-sovits:9880    synthesis, clones from a clip
  VIXTTS_URL      http://vixtts:19770       synthesis, clones or a preset speaker
  ASR_URL         http://whisper:9000       recognition

``TTS_DEFAULT_MODEL`` picks which synthesis engine serves a request that names
none; unset, it is the first configured, in the order above.
"""

import os

from fastapi import HTTPException

from .base import UNAVAILABLE, Engine
from .gptsovits import GPTSoVITS
from .reference import VoiceReference
from .vixtts import ViXTTS
from .whisper import Whisper

__all__ = [
    "Engine", "GPTSoVITS", "UNAVAILABLE", "ViXTTS", "VoiceReference", "Whisper",
    "catalogue", "recognition", "synthesis", "synthesis_engines",
]

_SYNTHESIS = ((GPTSoVITS, "GPTSOVITS_URL"), (ViXTTS, "VIXTTS_URL"))

NO_SYNTHESIS = (
    "No speech synthesis engine is configured on this server. "
    "Start one with `docker compose --profile vixtts up -d` and set VIXTTS_URL."
)
NO_RECOGNITION = (
    "No speech recognition engine is configured on this server. "
    "Start one with `docker compose --profile whisper up -d` and set ASR_URL."
)


def synthesis_engines() -> list[Engine]:
    """Every configured synthesis engine, in declaration order."""
    engines = []
    for engine_class, variable in _SYNTHESIS:
        url = os.environ.get(variable, "").strip()
        if url:
            engines.append(engine_class(url))
    return engines


def recognition() -> Engine:
    """The recognition engine, or a 502 naming what to start."""
    url = os.environ.get("ASR_URL", "").strip()
    if not url:
        raise HTTPException(status_code=502, detail=NO_RECOGNITION)
    return Whisper(url)


def synthesis(model: str | None = None) -> Engine:
    """The synthesis engine for ``model``.

    ``model`` is what the client stored — ``vixtts``, ``gpt-sovits``. Absent
    means ``TTS_DEFAULT_MODEL``, and absent again the first configured engine.
    A model this deployment does not run is a 400 that names what it does run,
    because a picker offering a model that cannot speak is how #151 and #200
    both looked from the outside.
    """
    engines = synthesis_engines()
    if not engines:
        raise HTTPException(status_code=502, detail=NO_SYNTHESIS)
    wanted = (model or os.environ.get("TTS_DEFAULT_MODEL", "")).strip()
    if not wanted:
        return engines[0]
    for engine in engines:
        if engine.model_id == wanted:
            return engine
    available = ", ".join(engine.model_id for engine in engines)
    raise HTTPException(
        status_code=400,
        detail=f"This server does not run the speech model '{wanted}'. Available: {available}.",
    )


def catalogue(kind: str) -> list[dict]:
    """The models of one ``kind`` — ``"asr"`` or ``"tts"`` — this deployment runs.

    A 502 when it runs none, never an empty list: the clients render this as a
    picker, and an empty one reads as "nothing installed" rather than "nothing
    configured".
    """
    if kind == "asr":
        return [recognition().described()]
    engines = synthesis_engines()
    if not engines:
        raise HTTPException(status_code=502, detail=NO_SYNTHESIS)
    return [engine.described() for engine in engines]
