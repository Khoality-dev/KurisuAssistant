"""The retrieval index keeps itself in step, and remembers what it did (#6).

The indexer's functions and the scanner's queries are driven directly — no
worker threads — against the migrated test database, the way
``test_idle_scanner.py`` drives memory consolidation. The embedding provider is
the mock Ollama, made to fail on demand so the two failure kinds can be told
apart: a provider that is down pauses the backlog and touches no row; a provider
that refuses one text isolates that text and embeds the rest.
"""

import logging
import uuid
from datetime import datetime, timedelta

import pytest

from kurisuassistant.utils import embeddings as embedding_service
from kurisuassistant.utils import indexing
from kurisuassistant.utils.embeddings import TransientEmbedError
from kurisuassistant.workers import service as worker_module
from kurisuassistant.workers.service import BackgroundService, _index_key
from kurisuassistant.workers.tasks import ChunkConversationTask, ChunkDriveFileTask, EmbedPassagesTask
from tests.mock_ollama import EMBED_DIMENSIONS

pytestmark = pytest.mark.db

EMBED_MODEL = "mock-embedder"


@pytest.fixture(autouse=True)
def drive_root(tmp_path, monkeypatch):
    from kurisuassistant.utils import drive_storage

    monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path / "drive")
    return tmp_path / "drive"


@pytest.fixture(autouse=True)
def embedder(mock_ollama, monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "ollama")
    monkeypatch.setenv("EMBEDDING_MODEL", EMBED_MODEL)
    monkeypatch.setenv("LLM_API_URL", mock_ollama.url)
    embedding_service.reset()
    yield mock_ollama
    embedding_service.reset()


@pytest.fixture()
def db(system_client):
    from kurisuassistant.db.models import User
    from kurisuassistant.db.service import get_db_service

    svc = get_db_service()
    user_id = svc.execute_sync(lambda s: s.query(User).filter_by(username="tester").one().id)
    return svc, user_id


def _conversation(db, user_id, texts, *, roles=None):
    from kurisuassistant.db.models import Conversation, Message

    def _make(session):
        conv = Conversation(user_id=user_id, title=uuid.uuid4().hex)
        session.add(conv)
        session.flush()
        ids = []
        for i, text in enumerate(texts):
            role = (roles or ["user"] * len(texts))[i]
            msg = Message(conversation_id=conv.id, role=role, message=text)
            session.add(msg)
            session.flush()
            ids.append(msg.id)
        return conv.id, ids

    return db.execute_sync(_make)


def _add_message(db, conv_id, text):
    from kurisuassistant.db.models import Conversation, Message

    def _make(session):
        msg = Message(conversation_id=conv_id, role="user", message=text)
        session.add(msg)
        session.get(Conversation, conv_id).updated_at = datetime.utcnow()
        session.flush()
        return msg.id

    return db.execute_sync(_make)


def _passages(db, **where):
    from kurisuassistant.db.models import Passage

    def _q(session):
        rows = session.query(Passage).filter_by(**where).order_by(Passage.id).all()
        return [{
            "id": p.id, "content": p.content, "message_id": p.message_id,
            "drive_node_id": p.drive_node_id, "embedded": p.embedding is not None,
            "model": p.embedding_model, "attempts": p.embed_attempts, "page": p.page,
        } for p in rows]

    return db.execute_sync(_q)


def _conversation_row(db, conv_id):
    from kurisuassistant.db.models import Conversation

    def _q(session):
        c = session.get(Conversation, conv_id)
        return {"indexed_up_to_id": c.indexed_up_to_id, "indexed_at": c.indexed_at, "updated_at": c.updated_at}

    return db.execute_sync(_q)


async def _drive_file(db, user_id, name, content: bytes, mime=None, parent_id=None):
    from kurisuassistant.db.repositories import DriveNodeRepository
    from kurisuassistant.utils import drive_storage

    async def _chunks():
        yield content

    storage_key, size, checksum = await drive_storage.store_stream(user_id, _chunks(), 10 ** 9)
    return db.execute_sync(lambda s: DriveNodeRepository(s).create_file(
        user_id, parent_id, name, size, mime or drive_storage.guess_mime(name), checksum, storage_key,
    ).id)


async def _replace_drive_file(db, user_id, node_id, content: bytes):
    from kurisuassistant.db.repositories import DriveNodeRepository
    from kurisuassistant.utils import drive_storage

    async def _chunks():
        yield content

    storage_key, size, checksum = await drive_storage.store_stream(user_id, _chunks(), 10 ** 9)

    def _persist(session):
        repo = DriveNodeRepository(session)
        node = repo.get_by_user_and_id(user_id, node_id)
        repo.replace_file(node, size, node.mime, checksum, storage_key)

    db.execute_sync(_persist)


def _node(db, node_id):
    from kurisuassistant.db.models import DriveNode

    return db.execute_sync(lambda s: {
        "checksum": s.get(DriveNode, node_id).checksum,
        "indexed_checksum": s.get(DriveNode, node_id).indexed_checksum,
    })


class TestConversations:
    def test_new_messages_become_passages_and_the_watermark_moves(self, db):
        svc, user_id = db
        conv_id, ids = _conversation(svc, user_id, ["first thing said", "second thing said"])

        assert indexing.chunk_conversation(conv_id) == 2

        rows = _passages(svc, conversation_id=conv_id)
        assert [r["content"] for r in rows] == ["first thing said", "second thing said"]
        assert [r["message_id"] for r in rows] == ids
        row = _conversation_row(svc, conv_id)
        assert row["indexed_up_to_id"] == ids[-1]
        assert row["indexed_at"] is not None

    def test_a_second_run_indexes_only_what_is_new(self, db):
        svc, user_id = db
        conv_id, ids = _conversation(svc, user_id, ["already indexed"])
        indexing.chunk_conversation(conv_id)
        new_id = _add_message(svc, conv_id, "the new one")

        assert indexing.chunk_conversation(conv_id) == 1
        assert [r["message_id"] for r in _passages(svc, conversation_id=conv_id)] == ids + [new_id]
        assert _conversation_row(svc, conv_id)["indexed_up_to_id"] == new_id

    def test_only_user_and_assistant_text_is_indexed(self, db):
        svc, user_id = db
        conv_id, _ = _conversation(
            svc, user_id, ["user text", "assistant text", "tool output", "", "   "],
            roles=["user", "assistant", "tool", "assistant", "user"],
        )
        indexing.chunk_conversation(conv_id)
        assert [r["content"] for r in _passages(svc, conversation_id=conv_id)] == ["user text", "assistant text"]

    def test_a_long_message_becomes_several_ordered_passages(self, db):
        svc, user_id = db
        long_text = "\n\n".join(f"Paragraph {i}. " + "words and more words. " * 30 for i in range(6))
        conv_id, [mid] = _conversation(svc, user_id, [long_text])
        written = indexing.chunk_conversation(conv_id)
        rows = _passages(svc, message_id=mid)
        assert written == len(rows) > 1
        assert all(r["content"] in long_text for r in rows), "every passage is a verbatim slice"

    def test_a_big_backlog_is_chunked_in_bounded_batches_until_caught_up(self, db, monkeypatch):
        svc, user_id = db
        monkeypatch.setattr(indexing, "MESSAGES_PER_BATCH", 3)
        conv_id, ids = _conversation(svc, user_id, [f"message {i}" for i in range(8)])
        assert indexing.chunk_conversation(conv_id) == 8
        assert _conversation_row(svc, conv_id)["indexed_up_to_id"] == ids[-1]

    def test_deleting_from_a_message_takes_its_passages_and_needs_no_rewind(self, db):
        from kurisuassistant.db.repositories import MessageRepository

        svc, user_id = db
        conv_id, ids = _conversation(svc, user_id, ["keep", "drop me", "and me"])
        indexing.chunk_conversation(conv_id)

        svc.execute_sync(lambda s: MessageRepository(s).delete_from_message(ids[1], conv_id))

        assert [r["content"] for r in _passages(svc, conversation_id=conv_id)] == ["keep"]
        later = _add_message(svc, conv_id, "after the delete")
        indexing.chunk_conversation(conv_id)
        assert [r["content"] for r in _passages(svc, conversation_id=conv_id)] == ["keep", "after the delete"]
        assert later > ids[-1], "ids are monotonic, which is why the watermark never rewinds"

    def test_deleting_a_conversation_takes_every_passage(self, db):
        from kurisuassistant.db.repositories import ConversationRepository

        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["gone soon"])
        indexing.chunk_conversation(conv_id)
        svc.execute_sync(lambda s: ConversationRepository(s).delete_by_filter(id=conv_id))
        assert _passages(svc, conversation_id=conv_id) == []


class TestDriveFiles:
    async def test_a_text_file_is_chunked_and_stamped(self, db):
        svc, user_id = db
        node_id = await _drive_file(svc, user_id, "notes.md", b"# Title\n\nsome notes about a trip\n")

        assert indexing.chunk_drive_file(user_id, node_id) == 1

        [row] = _passages(svc, drive_node_id=node_id)
        assert row["content"] == "# Title\n\nsome notes about a trip"
        node = _node(svc, node_id)
        assert node["indexed_checksum"] == node["checksum"]

    async def test_a_pdf_keeps_its_page_numbers(self, db):
        from tests.test_extraction import _pdf_bytes

        svc, user_id = db
        node_id = await _drive_file(svc, user_id, "r.pdf", _pdf_bytes(["page one text", "page two text"]))
        assert indexing.chunk_drive_file(user_id, node_id) == 2
        assert [r["page"] for r in _passages(svc, drive_node_id=node_id)] == [1, 2]

    async def test_replacing_the_bytes_replaces_the_passages(self, db):
        svc, user_id = db
        node_id = await _drive_file(svc, user_id, "v.txt", b"version one of the file")
        indexing.chunk_drive_file(user_id, node_id)
        await _replace_drive_file(svc, user_id, node_id, b"version two of the file")

        assert (node_id, user_id) in indexing.due_drive_files(100), "checksum differs from indexed_checksum"
        indexing.chunk_drive_file(user_id, node_id)

        assert [r["content"] for r in _passages(svc, drive_node_id=node_id)] == ["version two of the file"]
        assert (node_id, user_id) not in indexing.due_drive_files(100)

    async def test_the_same_checksum_is_not_indexed_twice(self, db):
        svc, user_id = db
        node_id = await _drive_file(svc, user_id, "same.txt", b"unchanged")
        assert indexing.chunk_drive_file(user_id, node_id) == 1
        assert indexing.chunk_drive_file(user_id, node_id) == 0
        assert len(_passages(svc, drive_node_id=node_id)) == 1

    async def test_a_binary_is_stamped_without_passages(self, db):
        svc, user_id = db
        node_id = await _drive_file(svc, user_id, "pic.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
        assert indexing.chunk_drive_file(user_id, node_id) == 0
        assert _passages(svc, drive_node_id=node_id) == []
        node = _node(svc, node_id)
        assert node["indexed_checksum"] == node["checksum"], "looked at once, not once a minute"
        assert (node_id, user_id) not in indexing.due_drive_files(100)

    async def test_an_oversized_file_is_stamped_without_being_read(self, db, monkeypatch):
        svc, user_id = db
        monkeypatch.setattr(indexing, "MAX_FILE_BYTES", 10)
        node_id = await _drive_file(svc, user_id, "big.txt", b"more than ten bytes of text")
        assert indexing.chunk_drive_file(user_id, node_id) == 0
        node = _node(svc, node_id)
        assert node["indexed_checksum"] == node["checksum"]

    async def test_the_passage_cap_per_file_holds(self, db, monkeypatch):
        svc, user_id = db
        monkeypatch.setattr(indexing, "MAX_PASSAGES_PER_FILE", 2)
        text = "\n\n".join(f"Paragraph {i}. " + "words " * 200 for i in range(5))
        node_id = await _drive_file(svc, user_id, "long.txt", text.encode())
        assert indexing.chunk_drive_file(user_id, node_id) == 2

    async def test_deleting_the_node_takes_its_passages(self, db):
        from kurisuassistant.db.repositories import DriveNodeRepository

        svc, user_id = db
        node_id = await _drive_file(svc, user_id, "gone.txt", b"soon gone")
        indexing.chunk_drive_file(user_id, node_id)

        def _delete(session):
            repo = DriveNodeRepository(session)
            repo.delete_subtree(user_id, repo.get_by_user_and_id(user_id, node_id))

        svc.execute_sync(_delete)
        assert _passages(svc, drive_node_id=node_id) == []

    async def test_a_secret_file_is_never_indexed(self, db):
        svc, user_id = db
        node_id = await _drive_file(svc, user_id, "server.pem", b"-----BEGIN PRIVATE KEY-----\nabc\n")
        assert indexing.chunk_drive_file(user_id, node_id) == 0
        assert _passages(svc, drive_node_id=node_id) == []

    async def test_the_citation_path_walks_up_the_tree(self, db):
        from kurisuassistant.db.repositories import DriveNodeRepository

        svc, user_id = db
        folder = svc.execute_sync(lambda s: DriveNodeRepository(s).create_folder(user_id, None, "Reports").id)
        sub = svc.execute_sync(lambda s: DriveNodeRepository(s).create_folder(user_id, folder, "2026").id)
        node_id = await _drive_file(svc, user_id, "q3.md", b"quarter three", parent_id=sub)
        paths = svc.execute_sync(lambda s: DriveNodeRepository(s).paths_for(user_id, [node_id, folder]))
        assert paths == {node_id: "/Reports/2026/q3.md", folder: "/Reports"}


class TestTheScan:
    def test_a_changed_conversation_is_due_and_an_indexed_one_is_not(self, db):
        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["hello"])
        assert (conv_id, user_id) in indexing.due_conversations(1000)
        indexing.chunk_conversation(conv_id)
        assert (conv_id, user_id) not in indexing.due_conversations(1000)
        _add_message(svc, conv_id, "more")
        assert (conv_id, user_id) in indexing.due_conversations(1000)

    def test_the_scan_is_bounded_and_oldest_first(self, db):
        from kurisuassistant.db.models import Conversation

        svc, user_id = db
        ids = []
        for days in (30, 20, 10):
            conv_id, _ = _conversation(svc, user_id, ["x"])

            def _age(session, conv_id=conv_id, days=days):
                session.get(Conversation, conv_id).updated_at = datetime.utcnow() - timedelta(days=365 + days)

            svc.execute_sync(_age)
            ids.append(conv_id)
        due = [c for c, _ in indexing.due_conversations(2)]
        assert due == ids[:2]

    def test_pending_passages_excludes_what_is_in_flight(self, db):
        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["a", "b", "c"])
        indexing.chunk_conversation(conv_id)
        ids = [r["id"] for r in _passages(svc, conversation_id=conv_id)]
        pending = indexing.pending_passages(1000)
        assert set(ids) <= set(pending)
        assert ids[0] not in indexing.pending_passages(1000, exclude=[ids[0]])


class TestEmbedding:
    def test_pending_passages_get_vectors_from_the_configured_model(self, db, embedder):
        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["embed me", "and me"])
        indexing.chunk_conversation(conv_id)
        ids = [r["id"] for r in _passages(svc, conversation_id=conv_id)]

        assert indexing.embed_pending(ids) == 2

        rows = _passages(svc, conversation_id=conv_id)
        assert all(r["embedded"] and r["model"] == EMBED_MODEL for r in rows)
        assert set(ids).isdisjoint(indexing.pending_passages(1000))
        [request] = embedder.state.requests_to("/api/embed")
        assert request["input"] == ["embed me", "and me"], "one call for the batch"

    def test_a_provider_that_is_down_raises_transient_and_touches_no_row(self, db, embedder):
        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["still pending"])
        indexing.chunk_conversation(conv_id)
        ids = [r["id"] for r in _passages(svc, conversation_id=conv_id)]
        embedder.state.fail_embeddings(503)

        with pytest.raises(TransientEmbedError):
            indexing.embed_pending(ids)

        [row] = _passages(svc, conversation_id=conv_id)
        assert not row["embedded"] and row["attempts"] == 0

    def test_a_provider_that_refuses_isolates_the_row_and_embeds_the_rest(self, db, embedder, monkeypatch):
        """A 400 is about the input. Bisect until the one text the provider will
        not take stands alone, bump only it, and let the others through."""
        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["fine one", "poison", "fine two", "fine three"])
        indexing.chunk_conversation(conv_id)
        ids = [r["id"] for r in _passages(svc, conversation_id=conv_id)]

        real = embedding_service.embed_passages

        def refusing(texts):
            if "poison" in texts:
                from kurisuassistant.utils.embeddings import PermanentEmbedError
                raise PermanentEmbedError("400: cannot embed that")
            return real(texts)

        monkeypatch.setattr(embedding_service, "embed_passages", refusing)

        assert indexing.embed_pending(ids) == 3

        rows = {r["content"]: r for r in _passages(svc, conversation_id=conv_id)}
        assert rows["poison"]["attempts"] == 1 and not rows["poison"]["embedded"]
        for fine in ("fine one", "fine two", "fine three"):
            assert rows[fine]["embedded"] and rows[fine]["attempts"] == 0

    def test_a_row_refused_enough_times_leaves_the_backlog(self, db):
        from kurisuassistant.db.repositories import PassageRepository
        from kurisuassistant.db.repositories.passages import MAX_EMBED_ATTEMPTS

        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["hopeless"])
        indexing.chunk_conversation(conv_id)
        [row] = _passages(svc, conversation_id=conv_id)
        for _ in range(MAX_EMBED_ATTEMPTS):
            svc.execute_sync(lambda s: PassageRepository(s).bump_attempts([row["id"]]))
        assert row["id"] not in indexing.pending_passages(10_000)

    def test_a_changed_model_sweeps_the_old_vectors_back_into_the_backlog(self, db, embedder, monkeypatch):
        svc, user_id = db
        conv_id, _ = _conversation(svc, user_id, ["embedded by the old model"])
        indexing.chunk_conversation(conv_id)
        ids = [r["id"] for r in _passages(svc, conversation_id=conv_id)]
        indexing.embed_pending(ids)
        assert _passages(svc, conversation_id=conv_id)[0]["model"] == EMBED_MODEL

        assert indexing.sweep_stale_embeddings(EMBED_MODEL) == 0, "nothing stale for the same model"
        swept = indexing.sweep_stale_embeddings("a-new-model")
        assert swept >= 1

        [row] = _passages(svc, conversation_id=conv_id)
        assert not row["embedded"] and row["model"] is None and row["attempts"] == 0
        assert ids[0] in indexing.pending_passages(10_000)


class TestTheServiceRouting:
    def test_index_tasks_are_deduplicated_while_queued(self):
        svc = BackgroundService()
        svc.submit(ChunkConversationTask(user_id=1, conversation_id=7))
        svc.submit(ChunkConversationTask(user_id=1, conversation_id=7))
        svc.submit(ChunkDriveFileTask(user_id=1, node_id=7))
        svc.submit(EmbedPassagesTask(passage_ids=[1, 2]))
        svc.submit(EmbedPassagesTask(passage_ids=[1, 2]))
        assert svc._index_queue.qsize() == 3
        assert svc._embedding_in_flight == {1, 2}
        assert svc._db_queue.qsize() == 0, "the memory worker's queue is untouched"

    def test_keys_tell_the_kinds_apart(self):
        assert _index_key(ChunkConversationTask(1, 7)) != _index_key(ChunkDriveFileTask(1, 7))

    def test_a_transient_failure_pauses_the_backlog_with_backoff(self, monkeypatch, caplog):
        svc = BackgroundService()

        def down(ids):
            raise TransientEmbedError("connection refused")

        monkeypatch.setattr(indexing, "embed_pending", down)
        with caplog.at_level(logging.WARNING, logger=worker_module.__name__):
            svc._handle_embed(EmbedPassagesTask(passage_ids=[1]))
            first = svc._embed_paused_until
            svc._handle_embed(EmbedPassagesTask(passage_ids=[1]))
            second = svc._embed_paused_until
        assert first is not None and second > first, "doubling"
        assert "pausing the embedding backlog" in caplog.text
        assert svc._embed_pause_failures == 2

        monkeypatch.setattr(indexing, "embed_pending", lambda ids: len(ids))
        svc._handle_embed(EmbedPassagesTask(passage_ids=[1]))
        assert svc._embed_paused_until is None and svc._embed_pause_failures == 0

    def test_the_scan_skips_embedding_while_paused(self, db, monkeypatch):
        svc = BackgroundService()
        svc._embed_paused_until = datetime.utcnow() + timedelta(minutes=5)
        asked = []
        monkeypatch.setattr(indexing, "pending_passages", lambda *a, **k: asked.append(1) or [])
        monkeypatch.setattr(indexing, "due_conversations", lambda n: [])
        monkeypatch.setattr(indexing, "due_drive_files", lambda n: [])
        svc._scan_index()
        assert asked == []
