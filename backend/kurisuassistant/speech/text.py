"""Text chunking and WAV joining — the shape every synthesis engine depends on.

A synthesis engine takes one chunk at a time (200 characters: paragraphs, then
sentences) and answers one WAV; ``synthesis.py`` cuts the text here and joins
the pieces here. The same two functions live in universal-voice
(``voice/universal_voice/tts/text_processing.py``) for as long as that service
also accepts whole paragraphs; the copy there goes when the engines take only
chunks (#212).
"""

import io
import logging
import re
import wave
from typing import List

logger = logging.getLogger(__name__)


def split_text(text: str, max_length: int = 200) -> List[str]:
    """Split text into chunks of at most ``max_length`` characters.

    Paragraphs (blank-line separated) first; a paragraph over the limit is cut
    at sentence boundaries, Latin and CJK. Empty text comes back as itself.
    """
    paragraphs = text.split("\n\n")
    chunks = []

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(para) <= max_length:
            chunks.append(para)
            continue

        # Split long paragraphs by sentences
        sentences = re.split(r"([。.!?！？\n])", para)
        current_chunk = ""

        for i in range(0, len(sentences), 2):
            sentence = sentences[i]
            delimiter = sentences[i + 1] if i + 1 < len(sentences) else ""
            segment = sentence + delimiter

            if current_chunk and len(current_chunk) + len(segment) > max_length:
                chunks.append(current_chunk.strip())
                current_chunk = segment
            else:
                current_chunk += segment

        if current_chunk.strip():
            chunks.append(current_chunk.strip())

    return chunks if chunks else [text]


def merge_wav_files(wav_chunks: List[bytes]) -> bytes:
    """Concatenate WAV files into one; a single chunk is returned untouched."""
    if not wav_chunks:
        raise ValueError("No audio chunks to merge")

    if len(wav_chunks) == 1:
        return wav_chunks[0]

    first_wav = io.BytesIO(wav_chunks[0])
    with wave.open(first_wav, "rb") as wav:
        params = wav.getparams()
        audio_data = [wav.readframes(wav.getnframes())]

    for chunk in wav_chunks[1:]:
        chunk_wav = io.BytesIO(chunk)
        with wave.open(chunk_wav, "rb") as wav:
            # Channels, sample width and rate. Not the frame count, which is
            # what made the copy in universal-voice warn on every merge.
            if wav.getparams()[:3] != params[:3]:
                logger.warning("WAV format mismatch, attempting to merge anyway")
            audio_data.append(wav.readframes(wav.getnframes()))

    merged = io.BytesIO()
    with wave.open(merged, "wb") as wav:
        wav.setparams(params)
        wav.writeframes(b"".join(audio_data))

    return merged.getvalue()
