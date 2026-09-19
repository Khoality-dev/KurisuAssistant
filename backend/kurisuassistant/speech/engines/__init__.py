"""Which engines this deployment has, and which one serves a request.

Every synthesis engine speaks the same contract, so it is configured by a name
and an address and nothing else (#227):

  TTS_ENGINES   gpt-sovits=http://kurisu-gpt-sovits:9880,vixtts=http://kurisu-vixtts:19770
  ASR_URL       http://kurisu-whisper:9000    recognition, its own dialect

The names are the model ids the clients already store. Nothing is discovered:
the backend knows what it was given, so a model listing costs no request and
cannot come back empty because something was briefly unreachable (#151).
``TTS_DEFAULT_MODEL`` picks which engine serves a request that names none;
unset, it is the first configured.
"""

import os

from fastapi import HTTPException

from .base import UNAVAILABLE, Engine
from .reference import VoiceReference
from .standard import CannotLoad, StandardEngine
from .whisper import Whisper

__all__ = [
    "CannotLoad", "Engine", "StandardEngine", "UNAVAILABLE", "VoiceReference", "Whisper",
    "catalogue", "recognition", "synthesis", "synthesis_engines",
]

NO_SYNTHESIS = (
    "No speech synthesis engine is configured on this server. "
    "Start one with `docker compose --profile gpt-sovits up -d` and name it in TTS_ENGINES."
)
NO_RECOGNITION = (
    "No speech recognition engine is configured on this server. "
    "Start one with `docker compose --profile whisper up -d` and set ASR_URL."
)


def synthesis_engines() -> list[StandardEngine]:
    """Every configured synthesis engine, in declaration order."""
    engines: list[StandardEngine] = []
    for entry in os.environ.get("TTS_ENGINES", "").split(","):
        name, _, url = entry.partition("=")
        name, url = name.strip(), url.strip()
        if name and url:
            engines.append(StandardEngine(name, url))
    return engines


def recognition() -> Engine:
    """The recognition engine, or a 502 naming what to start."""
    url = os.environ.get("ASR_URL", "").strip()
    if not url:
        raise HTTPException(status_code=502, detail=NO_RECOGNITION)
    return Whisper(url)


def synthesis(model: str | None = None) -> StandardEngine:
    """The synthesis engine for ``model``, the id the client stored.

    A model this deployment does not run is a 400 naming what it does run: a
    picker offering a model that cannot speak is how #151 and #200 both looked
    from the outside.
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
    picker, and an empty one reads as "nothing installed".
    """
    if kind == "asr":
        return [recognition().described()]
    engines = synthesis_engines()
    if not engines:
        raise HTTPException(status_code=502, detail=NO_SYNTHESIS)
    return [engine.described() for engine in engines]
