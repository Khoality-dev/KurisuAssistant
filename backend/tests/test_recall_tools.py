"""recall_regex and recall_semantic: the assistant's two ways back into past
material (#6).

Run the way ``BaseAgent.execute_tool`` runs them — ``user_id``, ``conversation_id``,
``_context`` and ``_available_tools`` injected into the arguments, none of them in
the schema. The passages come from the real indexer (``utils/indexing.py``) over
real messages and drive files; the embedding model is the mock Ollama, whose
vectors are pinned where a test needs two texts to be near each other.

The old ``history_search`` was an unindexed ``ILIKE`` that truncated every hit
to 200 characters and cited no message. What is asserted here is what it could
not do: a hit is quoted whole, names its conversation, speaker, time and message
id — or its file path and page — and a question in other words still finds it.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one).
"""

import os
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from kurisuassistant.tools import tool_registry
from kurisuassistant.tools.drive import DriveWriteTool
from kurisuassistant.tools.recall import (
    DOCS_NOT_SEARCHED,
    DOCS_ONLY_REFUSED,
    RecallRegexTool,
    RecallSemanticTool,
)
from kurisuassistant.utils import embeddings as embedding_service
from kurisuassistant.utils import indexing
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
    """Embeddings through the mock Ollama, with a fresh provider per test."""
    monkeypatch.setenv("EMBEDDING_PROVIDER", "ollama")
    monkeypatch.setenv("EMBEDDING_MODEL", EMBED_MODEL)
    monkeypatch.setenv("LLM_API_URL", mock_ollama.url)
    embedding_service.reset()
    yield mock_ollama
    embedding_service.reset()


@pytest.fixture()
def accounts(system_db):
    """Two activated accounts, so "not yours" can be tested at all."""
    from kurisuassistant.core.accounts import provision_user
    from kurisuassistant.core.security import hash_password
    from kurisuassistant.db.repositories import UserRepository
    from kurisuassistant.db.session import get_session

    ids = []
    for _ in range(2):
        with get_session() as session:
            repo = UserRepository(session)
            user = repo.create_user(f"recall-{uuid.uuid4().hex[:8]}", hash_password("x"))
            provision_user(session, user)
            user.is_active = True
            session.flush()
            ids.append(user.id)
    return ids


@pytest.fixture()
def db(system_client):
    from kurisuassistant.db.service import get_db_service

    return get_db_service()


def _conversation(db, user_id, title, turns, *, when=None, compacted_up_to=None):
    """A conversation with ``turns`` as (role, text) pairs, indexed. Returns
    ``(conversation_id, [message ids])``."""
    from kurisuassistant.db.models import Conversation, Message

    def _make(session):
        conv = Conversation(user_id=user_id, title=title)
        session.add(conv)
        session.flush()
        ids = []
        for i, (role, text) in enumerate(turns):
            msg = Message(
                conversation_id=conv.id, role=role, message=text,
                name="Kurisu" if role == "assistant" else None,
                created_at=(when or datetime.utcnow()) + timedelta(seconds=i),
            )
            session.add(msg)
            session.flush()
            ids.append(msg.id)
        if compacted_up_to is not None:
            conv.compacted_up_to_id = ids[compacted_up_to]
        return conv.id, ids

    conv_id, ids = db.execute_sync(_make)
    indexing.chunk_conversation(conv_id)
    return conv_id, ids


async def _file(db, user_id, path, content):
    """A drive file written through the assistant's own tool, then indexed."""
    result = await DriveWriteTool().execute({"user_id": user_id, "path": path, "content": content})
    assert "Written to" in result, result
    from kurisuassistant.db.repositories import DriveNodeRepository

    node_id = db.execute_sync(lambda s: DriveNodeRepository(s).resolve_path(user_id, path).id)
    indexing.chunk_drive_file(user_id, node_id)
    return node_id


def _embed_everything(db):
    ids = indexing.pending_passages(1000)
    while ids:
        indexing.embed_pending(ids)
        ids = indexing.pending_passages(1000)


def _ctx(policies=None):
    return SimpleNamespace(tool_policies=policies or {})


async def _regex(user_id, pattern, **extra):
    return await RecallRegexTool().execute({"user_id": user_id, "pattern": pattern, **extra})


async def _semantic(user_id, query, **extra):
    return await RecallSemanticTool().execute({"user_id": user_id, "query": query, **extra})


class TestRegistration:
    def test_both_are_registered_and_history_search_is_gone(self):
        assert tool_registry.get("recall_regex") is not None
        assert tool_registry.get("recall_semantic") is not None
        assert tool_registry.get("history_search") is None, "removed, not aliased"

    def test_they_are_built_in_like_the_history_tools(self):
        assert tool_registry.get("recall_regex").built_in is True
        assert tool_registry.get("recall_semantic").built_in is True

    def test_nothing_injected_is_in_the_schema(self):
        for tool in (RecallRegexTool(), RecallSemanticTool()):
            properties = tool.get_schema()["function"]["parameters"]["properties"]
            for injected in ("user_id", "conversation_id", "_context", "_available_tools"):
                assert injected not in properties, (tool.name, injected)

    def test_each_requires_its_own_query_field(self):
        assert RecallRegexTool().get_schema()["function"]["parameters"]["required"] == ["pattern"]
        assert RecallSemanticTool().get_schema()["function"]["parameters"]["required"] == ["query"]


class TestNoUserContext:
    async def test_they_refuse(self):
        assert "No user context" in await RecallRegexTool().execute({"pattern": "x"})
        assert "No user context" in await RecallSemanticTool().execute({"query": "x"})


class TestRegex:
    async def test_a_hit_is_quoted_whole_and_cites_the_message(self, db, accounts):
        owner, _ = accounts
        long_text = "We agreed the passport renewal appointment is on 14 March at the embassy. " * 4
        conv_id, ids = _conversation(db, owner, "Trip admin", [
            ("user", "Remind me about the embassy."),
            ("assistant", long_text.strip()),
        ], when=datetime(2026, 3, 1, 9, 30))

        out = await _regex(owner, "passport renewal")

        assert f'[1] Conversation #{conv_id} "Trip admin" — Kurisu, 2026-03-01 09:30, message #{ids[1]}' in out
        assert long_text.strip() in out.replace("> ", ""), "the whole passage, not a 200-character snippet"

    async def test_it_is_a_regex_and_case_insensitive(self, db, accounts):
        owner, _ = accounts
        conv_id, _ = _conversation(db, owner, "Flights", [
            ("user", "Book the flight to HANOI, not the one from Hanoi."),
        ])
        out = await _regex(owner, r"flight (to|from) hanoi", scope="conversations")
        assert f"Conversation #{conv_id}" in out

    async def test_newest_first(self, db, accounts):
        owner, _ = accounts
        old, _ = _conversation(db, owner, "Old", [("user", "the anchor word is zebra")],
                               when=datetime(2025, 1, 1))
        new, _ = _conversation(db, owner, "New", [("user", "again the anchor word is zebra")],
                               when=datetime(2026, 1, 1))
        out = await _regex(owner, "zebra")
        assert out.index(f"Conversation #{new}") < out.index(f"Conversation #{old}")

    async def test_an_invalid_pattern_is_a_sentence_not_a_traceback(self, db, accounts):
        owner, _ = accounts
        out = await _regex(owner, "unbalanced (paren")
        assert out.startswith("Error: not a valid regular expression")

    async def test_nothing_found_says_so(self, db, accounts):
        owner, _ = accounts
        assert await _regex(owner, "qzxv-never-said") == "No passage matches /qzxv-never-said/."

    async def test_date_filters(self, db, accounts):
        owner, _ = accounts
        early, _ = _conversation(db, owner, "Early", [("user", "the dated marker")], when=datetime(2024, 5, 1))
        late, _ = _conversation(db, owner, "Late", [("user", "the dated marker")], when=datetime(2026, 5, 1))
        out = await _regex(owner, "dated marker", after="2025-01-01")
        assert f"Conversation #{late}" in out and f"Conversation #{early}" not in out
        out = await _regex(owner, "dated marker", before="2025-01-01")
        assert f"Conversation #{early}" in out and f"Conversation #{late}" not in out

    async def test_tool_messages_are_not_indexed(self, db, accounts):
        owner, _ = accounts
        _conversation(db, owner, "Tools", [("tool", "raw tool output with the word gadget")])
        assert "No passage" in await _regex(owner, "gadget")


class TestIsolation:
    async def test_another_users_conversations_are_invisible(self, db, accounts):
        owner, other = accounts
        _conversation(db, other, "Theirs", [("user", "a private word: quokka")])
        assert "No passage" in await _regex(owner, "quokka")

    async def test_another_users_files_are_invisible(self, db, accounts):
        owner, other = accounts
        await _file(db, other, "/theirs.md", "a private file mentioning wombats")
        assert "No passage" in await _regex(owner, "wombats")


class TestTheCurrentConversation:
    async def test_what_is_still_in_context_is_skipped_but_compacted_history_is_not(self, db, accounts):
        owner, _ = accounts
        conv_id, ids = _conversation(db, owner, "Long one", [
            ("user", "early remark about the lighthouse"),
            ("assistant", "noted the lighthouse"),
            ("user", "recent remark about the lighthouse"),
        ], compacted_up_to=1)

        out = await _regex(owner, "lighthouse", conversation_id=conv_id)

        assert f"message #{ids[0]}" in out and f"message #{ids[1]}" in out, "compacted away: recallable"
        assert f"message #{ids[2]}" not in out, "still verbatim in context: skipped"

    async def test_in_conversation_searches_only_that_one(self, db, accounts):
        owner, _ = accounts
        a, _ = _conversation(db, owner, "A", [("user", "the shared keyword marmot")])
        b, _ = _conversation(db, owner, "B", [("user", "the shared keyword marmot")])
        out = await _regex(owner, "marmot", in_conversation=a)
        assert f"Conversation #{a}" in out and f"Conversation #{b}" not in out


class TestDocuments:
    async def test_a_file_hit_cites_its_path_and_lines(self, db, accounts):
        owner, _ = accounts
        node_id = await _file(db, owner, "/notes.md", "# Packing\n\n- passport\n- charger\n- the blue adapter\n")
        out = await _regex(owner, "blue adapter", scope="documents")
        assert f"[1] /notes.md, lines 1–5 — file #{node_id}" in out
        assert "> - the blue adapter" in out

    async def test_a_pdf_hit_cites_the_page(self, db, accounts, drive_root):
        from tests.test_extraction import _pdf_bytes
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.utils import drive_storage

        owner, _ = accounts
        data = _pdf_bytes(["Page one about cats", "Page two mentions the tortoise"])

        async def _chunks():
            yield data

        storage_key, size, checksum = await drive_storage.store_stream(owner, _chunks(), 10 ** 9)
        node_id = db.execute_sync(lambda s: DriveNodeRepository(s).create_file(
            owner, None, "animals.pdf", size, "application/pdf", checksum, storage_key,
        ).id)
        indexing.chunk_drive_file(owner, node_id)

        out = await _regex(owner, "tortoise")
        assert f"[1] /animals.pdf, page 2 — file #{node_id}" in out

    async def test_documents_and_conversations_come_back_together(self, db, accounts):
        owner, _ = accounts
        conv_id, _ = _conversation(db, owner, "Chat", [("user", "the pelican keyword in chat")])
        node_id = await _file(db, owner, "/birds.txt", "the pelican keyword in a file")
        out = await _regex(owner, "pelican keyword")
        assert f"Conversation #{conv_id}" in out and f"file #{node_id}" in out


class TestTheDriveGate:
    """Documents are included only when drive_read itself could run."""

    async def test_an_allowlist_without_drive_read_hides_documents(self, db, accounts):
        owner, _ = accounts
        await _file(db, owner, "/gated.txt", "the gated keyword otter")
        out = await _regex(owner, "otter", _available_tools=["history_read", "recall_regex"], _context=_ctx())
        assert "file #" not in out
        assert DOCS_NOT_SEARCHED in out

    async def test_a_denied_drive_read_hides_documents(self, db, accounts):
        owner, _ = accounts
        await _file(db, owner, "/denied.txt", "the denied keyword ibex")
        out = await _regex(owner, "ibex", _available_tools=None, _context=_ctx({"drive_read": "deny"}))
        assert "file #" not in out and DOCS_NOT_SEARCHED in out

    async def test_documents_only_under_the_gate_is_refused_outright(self, db, accounts):
        owner, _ = accounts
        out = await _regex(owner, "anything", scope="documents", _context=_ctx({"drive_read": "deny"}))
        assert out == DOCS_ONLY_REFUSED

    async def test_an_allowlist_with_drive_read_or_an_unset_policy_admits_documents(self, db, accounts):
        owner, _ = accounts
        node_id = await _file(db, owner, "/open.txt", "the open keyword yak")
        out = await _regex(owner, "yak", _available_tools=["drive_read"], _context=_ctx())
        assert f"file #{node_id}" in out
        assert DOCS_NOT_SEARCHED not in out


class TestSemantic:
    async def test_a_question_in_other_words_finds_the_passage(self, db, accounts, embedder):
        owner, _ = accounts
        said = "I left the spare house key under the third flowerpot on the balcony."
        asked = "where did I hide the extra key?"
        # The mock has no notion of meaning; pin the two texts next to each other
        # and everything else stays where the hash puts it.
        near = [1.0] + [0.0] * (EMBED_DIMENSIONS - 1)
        embedder.state.script_embedding(said, near)
        embedder.state.script_embedding(asked, [0.99, 0.14] + [0.0] * (EMBED_DIMENSIONS - 2))
        conv_id, ids = _conversation(db, owner, "House", [
            ("user", said),
            ("user", "and the weather was lovely, unrelated"),
        ])
        _embed_everything(db)

        out = await _semantic(owner, asked, limit=1)

        assert f"Conversation #{conv_id}" in out and f"message #{ids[0]}" in out
        assert said in out.replace("> ", "")
        [request] = [r for r in embedder.state.requests_to("/api/embed") if r["input"] == [asked]]
        assert request["model"].startswith(EMBED_MODEL), "the query is embedded with the configured model"

    async def test_the_old_search_would_have_missed_it(self, db, accounts):
        """The reason the index exists: no word of the question is in the answer."""
        owner, _ = accounts
        _conversation(db, owner, "House", [
            ("user", "I left the spare house key under the third flowerpot on the balcony."),
        ])
        assert "No passage" in await _regex(owner, "where did I hide the extra key")

    async def test_documents_are_searched_by_meaning_too(self, db, accounts, embedder):
        owner, _ = accounts
        text = "Quarterly revenue rose eleven percent on the strength of the Hanoi office."
        embedder.state.script_embedding(text, [0.0, 1.0] + [0.0] * (EMBED_DIMENSIONS - 2))
        embedder.state.script_embedding("how did sales go", [0.1, 0.99] + [0.0] * (EMBED_DIMENSIONS - 2))
        node_id = await _file(db, owner, "/q3.txt", text)
        _embed_everything(db)
        out = await _semantic(owner, "how did sales go", limit=1)
        assert f"file #{node_id}" in out

    async def test_when_the_embedding_model_is_down_it_says_to_use_regex(self, db, accounts, embedder):
        owner, _ = accounts
        embedder.state.fail_embeddings(503)
        out = await _semantic(owner, "anything at all")
        assert out.startswith("Error: the embedding model is not answering")
        assert "recall_regex" in out

    async def test_when_embeddings_are_switched_off_it_says_so(self, db, accounts, monkeypatch):
        owner, _ = accounts
        monkeypatch.setenv("EMBEDDING_MODEL", "")
        embedding_service.reset()
        out = await _semantic(owner, "anything")
        assert "switched off" in out and "recall_regex" in out

    async def test_only_vectors_from_the_current_model_are_compared(self, db, accounts, embedder, monkeypatch):
        owner, _ = accounts
        text = "a passage embedded by yesterday's model"
        embedder.state.script_embedding(text, [1.0] + [0.0] * (EMBED_DIMENSIONS - 1))
        embedder.state.script_embedding("query", [1.0] + [0.0] * (EMBED_DIMENSIONS - 1))
        _conversation(db, owner, "Models", [("user", text)])
        _embed_everything(db)

        monkeypatch.setenv("EMBEDDING_MODEL", "tomorrows-model")
        embedding_service.reset()
        out = await _semantic(owner, "query", limit=1)
        assert "Nothing close to that has been indexed yet" in out


class TestDescribeCall:
    def test_the_approval_bar_names_the_pattern_and_where(self):
        assert RecallRegexTool().describe_call({"pattern": "passport", "scope": "documents"}) == (
            "Recall by pattern /passport/ in stored documents"
        )
        assert RecallSemanticTool().describe_call({"query": "the key"}) == (
            "Recall by meaning: 'the key' in past conversations and documents"
        )

    def test_it_survives_arguments_of_the_wrong_type(self):
        assert "42" in RecallRegexTool().describe_call({"pattern": 42, "scope": ["x"]})
        assert RecallSemanticTool().describe_call({}).startswith("Recall by meaning")
