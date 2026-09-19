"""Fakes for the speech tests: an engine's answers, and WAVs to join.

Every adapter reaches its engine through ``Engine.call``, which uses
``kurisuassistant.speech.engines.base.get_client``; patching that is the whole
seam. A real ``httpx.Response`` is used so ``raise_for_status`` behaves like the
real thing.
"""

import io
import wave
from unittest.mock import AsyncMock, MagicMock

import httpx

GPTSOVITS = "http://gpt-sovits:9880"
VIXTTS = "http://vixtts:19770"
WHISPER = "http://whisper:9000"
SEAM = "kurisuassistant.speech.engines.base.get_client"


def response(status: int = 200, *, content: bytes | None = None, json=None, url: str = GPTSOVITS) -> httpx.Response:
    """An engine's answer. ``content`` for audio, ``json`` for everything else."""
    request = httpx.Request("POST", url)
    if json is not None:
        return httpx.Response(status, json=json, request=request)
    return httpx.Response(status, content=content or b"", request=request)


def client_answering(*answers) -> MagicMock:
    """A fake shared client. One answer is repeated; several are given in turn.

    An exception instance is raised instead of answered.
    """
    client = MagicMock()
    if len(answers) == 1:
        one = answers[0]
        client.request = AsyncMock(side_effect=one) if isinstance(one, BaseException) else AsyncMock(return_value=one)
    else:
        client.request = AsyncMock(side_effect=list(answers))
    return client


def calls(client: MagicMock) -> list[tuple[str, str, dict]]:
    """Every request made: ``(method, url, kwargs)``."""
    return [(c.args[0], c.args[1], c.kwargs) for c in client.request.call_args_list]


def wav(frames: int, rate: int = 16000) -> bytes:
    """A mono 16-bit WAV of ``frames`` silent frames."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * frames)
    return buf.getvalue()


def frames_in(wav_bytes: bytes) -> int:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.getnframes()
