"""One synthesis: the text in chunks, one WAV out."""

import asyncio
import logging
import wave

from fastapi import HTTPException

from kurisuassistant.core.errors import internal_error
from kurisuassistant.speech import engines
from kurisuassistant.speech.text import merge_wav_files, split_text

logger = logging.getLogger(__name__)

CONTEXT = "TTS synthesis"
# Synthesis of a long sentence legitimately takes a while; per chunk.
CHUNK_TIMEOUT = 120
# For the whole text. The desktop gives up on a synthesis after this long, so
# past it the engine would be working for nobody.
TOTAL_TIMEOUT = 300


async def synthesize(
    text: str,
    *,
    model: str | None = None,
    voice_id: str | None = None,
    language: str | None = None,
    ref_audio: tuple[str, bytes] | None = None,
) -> bytes:
    """Synthesize ``text`` on the synthesis engine and return one WAV.

    The text goes over in chunks (``split_text``: about 200 characters,
    paragraphs then sentences) and the pieces are joined here, so an engine only
    ever sees one chunk — the shape the per-engine containers of #212 have.
    viXTTS and GPT-SoVITS split a whole paragraph the same way themselves;
    handed a chunk they answer one piece, so nothing changes on the wire for
    them (VieNeu never split, and now receives chunks). Both clients send one
    sentence per request, so this is normally one call. ``ref_audio`` —
    ``(filename, bytes)`` — is uploaded with every chunk: an engine keeps
    nothing between requests.

    A chunk the engine refuses is skipped when there are others — inside the
    engine a chunk that normalises to nothing was skipped the same way — and
    the refusal is the answer only when nothing could be said.
    """
    engine = engines.synthesis_engine()
    chunks = split_text(text)
    logger.info("%s: %d chars in %d chunk(s), model=%s, voice_id=%s, language=%s, ref_audio=%s",
                CONTEXT, len(text), len(chunks), model, voice_id, language,
                ref_audio[0] if ref_audio else None)

    deadline = asyncio.get_running_loop().time() + TOTAL_TIMEOUT
    pieces: list[bytes] = []
    refusal: HTTPException | None = None
    for index, chunk in enumerate(chunks):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise internal_error(
                TimeoutError(f"{len(chunks)} chunks did not finish within {TOTAL_TIMEOUT}s"),
                CONTEXT, status_code=502, public_detail=engines.UNAVAILABLE,
            )
        data: dict = {"text": chunk}
        if model:
            data["model"] = model
        if language:
            data["language"] = language
        if voice_id:
            data["voice_id"] = voice_id
        files = {"ref_audio": ref_audio} if ref_audio else None
        try:
            response = await engines.call(
                engine, "POST", "/tts/synthesize", context=CONTEXT,
                data=data, files=files, timeout=min(CHUNK_TIMEOUT, remaining),
            )
        except HTTPException as e:
            if e.status_code != 400 or len(chunks) == 1:
                raise
            logger.info("%s: chunk %d/%d skipped: %s", CONTEXT, index + 1, len(chunks), e.detail)
            refusal = e
            continue
        pieces.append(response.content)

    if not pieces:
        raise refusal  # every chunk was refused; there is always at least one
    try:
        audio = merge_wav_files(pieces)
    except (wave.Error, EOFError) as e:
        # Not WAV, or truncated: the engine answered, but not with audio.
        raise internal_error(e, CONTEXT, status_code=502, public_detail=engines.UNAVAILABLE)
    logger.info("%s: %d bytes of audio", CONTEXT, len(audio))
    return audio
