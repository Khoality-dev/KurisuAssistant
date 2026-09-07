"""Keep the retrieval index (``passages``) in step with messages and drive files (#6).

Everything the ``index-worker`` thread does lives here, in the shape the rest of
the background code uses: plain functions, every database touch a synchronous
callable handed to ``DBService.execute_sync``, and **no network call inside a
database callable** — extraction and embedding happen on the worker thread,
and only their results enter the single database queue.

Three operations, one source of truth each:

* ``chunk_conversation`` reads messages above ``conversations.indexed_up_to_id``,
  cuts them into passages and advances the watermark — all in one callable, so
  a ``delete_from_message`` landing in between cannot leave a passage pointing
  at a message that is gone (the single database thread serialises the two).
* ``chunk_drive_file`` extracts a file's text off-thread, then in one callable
  re-checks the checksum it extracted is still the file's, replaces that file's
  passages and stamps ``drive_nodes.indexed_checksum``. The stamp is written
  whether or not any text came out: an unextractable file is looked at once per
  version, not once per minute.
* ``embed_pending`` embeds a batch of passages off-thread and writes the vectors
  in one callable. A transient failure propagates so the worker can pause; a
  permanent one is narrowed to the offending row, whose ``embed_attempts`` is
  bumped, and the rest of the batch goes through.

The scan queries at the bottom are what the ``index-scanner`` thread runs once a
minute to find work that the direct submits missed (a restart, a crash between
the write and the submit, a backfill onto an existing deployment).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import List, Optional, Sequence, Tuple

from kurisuassistant.utils import embeddings as embedding_service
from kurisuassistant.utils.chunking import chunk_text
from kurisuassistant.utils.embeddings import PermanentEmbedError

logger = logging.getLogger(__name__)

#: Files above this are stamped without being read. 20 MB of text is already
#: ~17k passages; anything that big is a dump, not a document.
MAX_FILE_BYTES = int(os.getenv("RETRIEVAL_MAX_FILE_BYTES", str(20 * 1024 * 1024)))
#: And a file that chunks into more than this stops here; the rest is not indexed.
MAX_PASSAGES_PER_FILE = int(os.getenv("RETRIEVAL_MAX_PASSAGES_PER_FILE", "2000"))
#: Messages read per database callable while chunking a conversation.
MESSAGES_PER_BATCH = 200
#: Which roles are worth recalling. Tool results are the model's own scratch
#: work and system text is not something the user said.
INDEXED_ROLES = ("user", "assistant")


def _db():
    from kurisuassistant.db.service import get_db_service

    return get_db_service()


# ── conversations ──────────────────────────────────────────────────────────────

def chunk_conversation(conversation_id: int) -> int:
    """Turn every message not yet indexed into passages. Returns how many
    passages were written. Loops in bounded batches until caught up."""
    total = 0
    while True:
        written, more = _db().execute_sync(lambda s: _chunk_conversation_batch(s, conversation_id))
        total += written
        if not more:
            return total


def _chunk_conversation_batch(session, conversation_id: int) -> Tuple[int, bool]:
    from kurisuassistant.db.models import Conversation, Message
    from kurisuassistant.db.repositories import PassageRepository

    conv = session.get(Conversation, conversation_id)
    if conv is None:
        return 0, False

    messages = (
        session.query(Message.id, Message.role, Message.message)
        .filter(
            Message.conversation_id == conversation_id,
            Message.id > (conv.indexed_up_to_id or 0),
        )
        .order_by(Message.id)
        .limit(MESSAGES_PER_BATCH)
        .all()
    )
    rows = []
    for message_id, role, text in messages:
        if role not in INDEXED_ROLES or not text or not text.strip():
            continue
        for ordinal, chunk in enumerate(chunk_text(text)):
            rows.append({
                "user_id": conv.user_id,
                "source_kind": "message",
                "conversation_id": conversation_id,
                "message_id": message_id,
                "drive_node_id": None,
                "ordinal": ordinal,
                "content": chunk.text,
                "page": None,
                "start_line": chunk.start_line,
                "end_line": chunk.end_line,
            })
    written = PassageRepository(session).insert_many(rows)
    if messages:
        conv.indexed_up_to_id = messages[-1][0]
    more = len(messages) == MESSAGES_PER_BATCH
    if not more:
        conv.indexed_at = datetime.utcnow()
    return written, more


# ── drive files ────────────────────────────────────────────────────────────────

def chunk_drive_file(user_id: int, node_id: int) -> int:
    """Index one drive file at its current checksum. Returns passages written."""
    from kurisuassistant.utils import drive_storage
    from kurisuassistant.utils.extraction import ExtractionError, extract

    def _read(session):
        from kurisuassistant.db.repositories import DriveNodeRepository

        node = DriveNodeRepository(session).get_by_user_and_id(user_id, node_id)
        if node is None or node.is_dir or not node.storage_key or not node.checksum:
            return None
        if node.indexed_checksum == node.checksum:
            return None
        return {
            "name": node.name, "mime": node.mime, "checksum": node.checksum,
            "storage_key": node.storage_key, "size": node.size,
        }

    meta = _db().execute_sync(_read)
    if meta is None:
        return 0

    pages = []
    if meta["size"] > MAX_FILE_BYTES:
        logger.info("Not indexing drive file %d for user %d: %d bytes is over the cap",
                    node_id, user_id, meta["size"])
    else:
        path = drive_storage.blob_path(user_id, meta["storage_key"])
        try:
            pages = extract(path, meta["name"], meta["mime"], MAX_FILE_BYTES)
        except ExtractionError as e:
            logger.info("Not indexing drive file %d for user %d (%s): %s",
                        node_id, user_id, meta["name"], e)
        except OSError as e:
            # The blob is gone or unreadable: nothing to index, but stamping it
            # would hide a real problem, so this one is not stamped.
            logger.error("Cannot read drive blob for node %d: %s", node_id, e)
            return 0

    rows = []
    truncated = False
    for page in pages:
        for chunk in chunk_text(page.text):
            if len(rows) >= MAX_PASSAGES_PER_FILE:
                truncated = True
                break
            rows.append({
                "user_id": user_id,
                "source_kind": "drive",
                "conversation_id": None,
                "message_id": None,
                "drive_node_id": node_id,
                "ordinal": len(rows),
                "content": chunk.text,
                "page": page.page,
                "start_line": chunk.start_line if page.page is None else None,
                "end_line": chunk.end_line if page.page is None else None,
            })
        if truncated:
            break
    if truncated:
        logger.warning("Drive file %d for user %d stops at %d passages; the rest is not indexed",
                       node_id, user_id, MAX_PASSAGES_PER_FILE)

    def _persist(session):
        from kurisuassistant.db.repositories import DriveNodeRepository, PassageRepository

        node = DriveNodeRepository(session).get_by_user_and_id(user_id, node_id)
        if node is None or node.checksum != meta["checksum"]:
            # Replaced while we were reading it. The new bytes are due on their
            # own; indexing the old ones would be wrong twice.
            return 0
        repo = PassageRepository(session)
        repo.delete_for_drive_node(node_id)
        written = repo.insert_many(rows)
        node.indexed_checksum = meta["checksum"]
        return written

    return _db().execute_sync(_persist)


# ── embeddings ─────────────────────────────────────────────────────────────────

def embed_pending(passage_ids: Sequence[int]) -> int:
    """Embed the given passages. Returns how many got a vector.

    Raises ``TransientEmbedError`` (and ``EmbeddingDisabled``) untouched so the
    worker can pause; handles ``PermanentEmbedError`` by bisecting the batch to
    the row the provider refuses and bumping only that row's ``embed_attempts``.
    """
    from kurisuassistant.db.repositories import PassageRepository

    pairs = _db().execute_sync(lambda s: PassageRepository(s).contents_for(passage_ids))
    if not pairs:
        return 0
    model = embedding_service.current_model()
    embedded, refused = _embed_pairs(pairs)
    if refused:
        _db().execute_sync(lambda s: PassageRepository(s).bump_attempts(refused))
        logger.warning("The embedding provider refused %d passage(s): %s", len(refused), refused)
    if embedded:
        _db().execute_sync(lambda s: PassageRepository(s).mark_embedded(embedded, model))
    return len(embedded)


def _embed_pairs(pairs: List[Tuple[int, str]]) -> Tuple[List[Tuple[int, List[float]]], List[int]]:
    """``(embedded [(id, vector)], refused [id])`` — bisecting on a permanent error."""
    try:
        vectors = embedding_service.embed_passages([text for _, text in pairs])
    except PermanentEmbedError:
        if len(pairs) == 1:
            return [], [pairs[0][0]]
        middle = len(pairs) // 2
        left_ok, left_bad = _embed_pairs(pairs[:middle])
        right_ok, right_bad = _embed_pairs(pairs[middle:])
        return left_ok + right_ok, left_bad + right_bad
    return [(pid, vec) for (pid, _), vec in zip(pairs, vectors)], []


def sweep_stale_embeddings(model: str, batch: int = 1000) -> int:
    """Forget every vector not made by ``model`` so the backlog re-embeds it.
    Bounded batches, one callable each; returns the total reset."""
    from kurisuassistant.db.repositories import PassageRepository

    total = 0
    while True:
        n = _db().execute_sync(lambda s: PassageRepository(s).reset_stale_model(model, batch))
        total += n
        if n < batch:
            return total


# ── what the scanner asks ──────────────────────────────────────────────────────

def due_conversations(limit: int) -> List[Tuple[int, int]]:
    """``(conversation_id, user_id)`` for conversations changed since last indexed."""
    def _query(session):
        from sqlalchemy import or_

        from kurisuassistant.db.models import Conversation

        rows = (
            session.query(Conversation.id, Conversation.user_id)
            .filter(or_(
                Conversation.indexed_at.is_(None),
                Conversation.indexed_at < Conversation.updated_at,
            ))
            .order_by(Conversation.updated_at)
            .limit(limit)
            .all()
        )
        return [(r[0], r[1]) for r in rows]

    return _db().execute_sync(_query)


def due_drive_files(limit: int) -> List[Tuple[int, int]]:
    """``(node_id, user_id)`` for files whose bytes changed since last indexed."""
    def _query(session):
        from kurisuassistant.db.models import DriveNode

        rows = (
            session.query(DriveNode.id, DriveNode.user_id)
            .filter(
                DriveNode.is_dir.is_(False),
                DriveNode.checksum.isnot(None),
                DriveNode.checksum.is_distinct_from(DriveNode.indexed_checksum),
            )
            .order_by(DriveNode.updated_at)
            .limit(limit)
            .all()
        )
        return [(r[0], r[1]) for r in rows]

    return _db().execute_sync(_query)


def pending_passages(limit: int, exclude: Sequence[int] = ()) -> List[int]:
    from kurisuassistant.db.repositories import PassageRepository

    return _db().execute_sync(lambda s: PassageRepository(s).pending_embed_ids(limit, exclude))
