"""Streaming response formatter with sentence chunking.

This module handles buffering and chunking of streaming LLM responses,
yielding complete sentences when delimiters are detected.
"""

import datetime
from typing import AsyncGenerator, Dict, List


# Sentence delimiters for chunking
DEFAULT_DELIMITERS = [".", "\n", "?", ":", "!", ";"]
MIN_WORDS_PER_CHUNK = 10


async def chunk_sentences(
    content_stream,
    delimiters: List[str] = None,
    min_words: int = MIN_WORDS_PER_CHUNK
) -> AsyncGenerator[Dict, None]:
    """Yield message chunks when complete sentences are detected.

    Buffers streaming content and yields messages when:
    1. A delimiter is found (., \n, ?, :, !, ;)
    2. The chunk contains at least min_words words

    Args:
        content_stream: Iterable of Ollama chunk responses
        delimiters: List of sentence delimiters (default: [".", "\n", "?", ":", "!", ";"])
        min_words: Minimum words required before yielding (default: 10)

    Yields:
        Dict with role="assistant", content, created_at
    """
    if delimiters is None:
        delimiters = DEFAULT_DELIMITERS

    buffer = ""

    for chunk in content_stream:
        msg = chunk.message
        buffer += msg.content

        # Find the last occurrence of any delimiter in the buffer
        last_delimiter_pos = -1
        for delimiter in delimiters:
            pos = buffer.rfind(delimiter)
            if pos > last_delimiter_pos:
                last_delimiter_pos = pos

        # If we found a delimiter, check if we have a complete sentence with minimum words
        if last_delimiter_pos >= 0:
            # Extract the complete sentence(s) up to and including the delimiter
            complete_sentence = buffer[:last_delimiter_pos + 1]
            word_count = len(complete_sentence.split())

            # Yield if we have at least min_words
            if word_count >= min_words:
                created_at = datetime.datetime.utcnow().isoformat()
                message = {
                    "role": "assistant",
                    "content": complete_sentence,
                    "created_at": created_at,
                }
                yield message

                # Keep the remaining part in buffer
                buffer = buffer[last_delimiter_pos + 1:]

    # Yield any remaining buffer content
    rstrip_buffer = buffer.rstrip()
    if rstrip_buffer:
        created_at = datetime.datetime.utcnow().isoformat()
        message = {
            "role": "assistant",
            "content": rstrip_buffer,
            "created_at": created_at,
        }
        yield message
