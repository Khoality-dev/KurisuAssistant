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
    reference: engines.VoiceReference | None = None,
    voice_id: str | None = None,
    language: str | None = None,
) -> bytes:
    """Synthesize ``text`` on the engine for ``model`` and return one WAV.

    The text goes over in chunks (``split_text``: about 200 characters,
    paragraphs then sentences) and the pieces are joined here, so an engine only
    ever sees one chunk. Both clients send one sentence per request, so this is
    normally one call. The reference clip goes with every chunk — an engine
    keeps nothing between requests.

    A chunk the engine refuses is skipped when there are others, and the
    refusal is the answer only when nothing could be said.
    """
    engine = engines.synthesis(model)
    chunks = split_text(text)
    logger.info("%s: %d chars in %d chunk(s), engine=%s, voice=%s, language=%s",
                CONTEXT, len(text), len(chunks), engine.model_id,
                reference.filename if reference else voice_id, language)

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
        try:
            piece = await engine.synthesize(
                chunk, reference=reference, voice_id=voice_id, language=language,
                timeout=min(CHUNK_TIMEOUT, remaining),
            )
        except ValueError as e:
            # The engine cannot serve this request as asked — no reference clip
            # for one that only clones. The user's to fix, so it reads as itself.
            raise HTTPException(status_code=400, detail=str(e))
        except HTTPException as e:
            if e.status_code != 400 or len(chunks) == 1:
                raise
            logger.info("%s: chunk %d/%d skipped: %s", CONTEXT, index + 1, len(chunks), e.detail)
            refusal = e
            continue
        pieces.append(piece)

    if not pieces:
        raise refusal  # every chunk was refused; there is always at least one
    try:
        audio = merge_wav_files(pieces)
    except (wave.Error, EOFError) as e:
        # Not WAV, or truncated: the engine answered, but not with audio.
        raise internal_error(e, CONTEXT, status_code=502, public_detail=engines.UNAVAILABLE)
    logger.info("%s: %d bytes of audio", CONTEXT, len(audio))
    return audio
