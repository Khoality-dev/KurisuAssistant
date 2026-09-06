"""How much of the context window a message list occupies.

The old estimate was ``words * 1.3`` over ``content`` alone (#99). That ignored
images, tool arguments, tool results, thinking blocks and per-message framing,
and it drove both the compaction trigger and the counter shown to the user — so
a conversation with pictures or heavy tool use could be off by a large multiple,
in the direction that overruns the model's real window.

This is still an estimate. No provider here reports its own prompt token count
back to us (Ollama's ``prompt_eval_count`` and the OpenAI-dialect ``usage``
block never reach the handler), so the honest options were a tokenizer per
provider or a better approximation. This is the approximation, and it is
deliberately biased **high**: a summary that fires slightly early costs one
extra call, and one that fires slightly late costs the turn.

Character-based rather than word-based, because the failure cases are exactly
the ones where words are a poor proxy — JSON payloads, code, paths, and
languages that do not put spaces between words.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

# ~4 characters per token for English prose, and fewer for code and JSON, which
# is why this rounds up rather than down.
CHARS_PER_TOKEN = 4

# Role, separators and the model's own message framing. Small, but a long
# conversation is mostly framing at the margin.
PER_MESSAGE_OVERHEAD_TOKENS = 4

# One image, in tokens. Vision models tile an image and charge per tile, so the
# real figure depends on the model and the resolution: a 1024x1024 image is
# ~750 tokens for Qwen2-VL, ~1100 for GPT-4o, ~1600 for a high-detail tile.
# 1024 sits in the middle of that, and a picture is never free — which is the
# point, since the old count charged nothing at all for one.
TOKENS_PER_IMAGE = 1024


def chars_to_tokens(chars: int) -> int:
    """Tokens for a length of text, rounded up.

    Takes a count rather than the text so a streaming response can be measured
    as it arrives, without keeping it in memory to re-measure.
    """
    return -(-chars // CHARS_PER_TOKEN) if chars > 0 else 0


def estimate_text_tokens(text: str | None) -> int:
    """Tokens for a run of text, rounded up."""
    if not text:
        return 0
    return chars_to_tokens(len(text))


def _payload_tokens(value: Any) -> int:
    """Tokens for a structured field — tool arguments, a tool call list.

    Serialized the way it goes to the model, so the braces and quotes that the
    model does pay for are counted.
    """
    if value is None:
        return 0
    if isinstance(value, str):
        return estimate_text_tokens(value)
    try:
        return estimate_text_tokens(json.dumps(value, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return estimate_text_tokens(str(value))


def estimate_message_tokens(message: Mapping[str, Any]) -> int:
    """Tokens for one message, counting everything that reaches the model."""
    total = PER_MESSAGE_OVERHEAD_TOKENS
    total += estimate_text_tokens(message.get("role"))
    total += estimate_text_tokens(message.get("name"))
    total += estimate_text_tokens(message.get("content"))
    # Reasoning the model produced and may be shown its own copy of.
    total += estimate_text_tokens(message.get("thinking"))
    # Tool traffic: the arguments going out and the result coming back. The
    # result arrives as ``content`` on a tool message and is already counted.
    total += _payload_tokens(message.get("tool_calls"))
    total += estimate_text_tokens(message.get("tool_call_id"))

    # Images are charged per image, never by the length of their identifier or
    # their base64: both are the wrong number by orders of magnitude, in
    # opposite directions.
    images = message.get("images")
    if isinstance(images, (list, tuple)):
        total += TOKENS_PER_IMAGE * len(images)
    elif images:
        total += TOKENS_PER_IMAGE

    return total


def estimate_tokens(messages: Iterable[Mapping[str, Any]]) -> int:
    """Tokens for a whole message list, as sent to the model."""
    return sum(estimate_message_tokens(m) for m in messages or ())
