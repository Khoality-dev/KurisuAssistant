"""The one embedding model the retrieval index uses (#6).

Embeddings are configured server-wide — ``EMBEDDING_PROVIDER`` and
``EMBEDDING_MODEL`` in the environment — rather than per user like the chat
model. Every vector in ``passages`` must come from the same model for a distance
between two of them to mean anything, and the index is one table, so the choice
is the operator's. Credentials are the server-wide ``*_API_KEY`` fallbacks; the
Ollama host is ``LLM_API_URL``. Setting ``EMBEDDING_MODEL`` empty switches the
semantic side off: ``recall_regex`` keeps working and ``recall_semantic`` says why
it cannot.

Two kinds of failure, because the indexer treats them differently:

- ``TransientEmbedError`` — the provider is unreachable, timing out, rate
  limiting or erroring on its side, or is misconfigured (a provider with no
  embeddings, a model that cannot be pulled). Nothing about the *rows* is wrong,
  so the indexer pauses and retries later without touching them.
- ``PermanentEmbedError`` — the provider looked at this request and refused it
  (4xx). One of the texts is the problem; the indexer isolates it and stops
  retrying that row.

The provider is built once and cached; ``reset()`` drops it for tests that
re-point the environment.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import List, Optional

logger = logging.getLogger(__name__)

DEFAULT_PROVIDER = "ollama"
DEFAULT_MODEL = "bge-m3"

#: Ollama serialises requests anyway, Gemini caps a batch at 100, and each
#: vector is ~15 KB as a text literal on the way into Postgres.
EMBED_BATCH_SIZE = 32


class EmbeddingError(Exception):
    """Base for everything below."""


class EmbeddingDisabled(EmbeddingError):
    """``EMBEDDING_MODEL`` is empty: the operator switched the semantic side off."""


class TransientEmbedError(EmbeddingError):
    """Try again later; the rows are fine."""


class PermanentEmbedError(EmbeddingError):
    """The provider refused this input; retrying the same rows will not help."""


def provider_name() -> str:
    return (os.getenv("EMBEDDING_PROVIDER", DEFAULT_PROVIDER) or DEFAULT_PROVIDER).strip().lower()


def current_model() -> str:
    """The configured model, or ``""`` when embeddings are switched off."""
    return os.getenv("EMBEDDING_MODEL", DEFAULT_MODEL).strip()


def enabled() -> bool:
    return bool(current_model())


_lock = threading.Lock()
_provider = None
_ensured_model: Optional[str] = None


def reset() -> None:
    """Forget the cached provider (tests re-point ``LLM_API_URL`` / ``EMBEDDING_*``)."""
    global _provider, _ensured_model
    with _lock:
        _provider = None
        _ensured_model = None


def _get_provider():
    """Build the provider once. Any failure here is transient by definition: it
    is the environment, not a row, that is wrong."""
    global _provider, _ensured_model
    model = current_model()
    if not model:
        raise EmbeddingDisabled("EMBEDDING_MODEL is empty")
    with _lock:
        if _provider is None:
            from kurisuassistant.models.llm import create_llm_provider

            try:
                _provider = create_llm_provider(provider_name())
            except Exception as e:
                raise TransientEmbedError(f"cannot build the {provider_name()} provider: {e}") from e
        if _ensured_model != model:
            # Once, not per batch: for Ollama this is a `list` and possibly a
            # multi-gigabyte pull, which is worth one loud log line either way.
            try:
                pulled = _provider.ensure_model_available(model)
            except Exception as e:
                logger.error(
                    "Embedding model %r is not available from %s: %s",
                    model, provider_name(), e,
                )
                raise TransientEmbedError(f"embedding model {model!r} unavailable: {e}") from e
            if pulled:
                logger.info("Pulled embedding model %r", model)
            _ensured_model = model
        return _provider


def _status_of(exc: BaseException) -> Optional[int]:
    """The HTTP status behind a provider exception, whichever client raised it."""
    for candidate in (exc, getattr(exc, "response", None)):
        code = getattr(candidate, "status_code", None)
        if isinstance(code, int):
            return code
    return None


def _classify(exc: BaseException) -> EmbeddingError:
    if isinstance(exc, EmbeddingError):
        return exc
    if isinstance(exc, NotImplementedError):
        return TransientEmbedError(str(exc))
    status = _status_of(exc)
    if status is not None and 400 <= status < 500 and status not in (408, 429):
        return PermanentEmbedError(f"{provider_name()} refused the request ({status}): {exc}")
    return TransientEmbedError(f"{provider_name()} embedding failed: {exc}")


def embed_texts(texts: List[str], *, kind: str = "passage") -> List[List[float]]:
    """One vector per text, in order. Raises one of the errors above."""
    if not texts:
        return []
    provider = _get_provider()
    model = current_model()
    try:
        vectors = provider.embed(model, list(texts), kind=kind)
    except Exception as e:
        raise _classify(e) from e
    if len(vectors) != len(texts):
        raise TransientEmbedError(
            f"{provider_name()} returned {len(vectors)} vectors for {len(texts)} texts"
        )
    return vectors


def embed_passages(texts: List[str]) -> List[List[float]]:
    return embed_texts(texts, kind="passage")


def embed_query(text: str) -> List[float]:
    return embed_texts([text], kind="query")[0]
