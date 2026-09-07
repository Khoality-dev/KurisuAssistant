"""Recall — the assistant's two ways back into past conversations and stored files (#6).

Both tools read the same index (``passages``: verbatim slices of every message
the user exchanged and of every readable file in their drive) and differ only in
how they look:

- ``recall_regex`` matches a case-insensitive POSIX regular expression against
  the text — for when the wording is known: a name, a number, a phrase.
- ``recall_semantic`` embeds a description and returns the passages closest to
  it in meaning — for when the wording is not known.

The model picks. Nothing here merges or re-ranks the two; a tool result is a
list of passages, newest first or closest first, each quoted **verbatim** under
a line that says where it came from. That is the whole point of the index over
the summary it replaces: an answer about the past can quote what was actually
said or written, and say where.

Scope comes from ``args["user_id"]``, injected by ``BaseAgent.execute_tool``
after the model has produced its arguments — not in the schema, so the model
cannot name another account. Both tools are ``built_in``, like the history
tools they replace, so recall is always available. **Document passages are
not.** They are included only when ``drive_read`` would itself be allowed: in
the agent's allowlist (``_available_tools``, also injected) and not denied by
``users.tool_policies``. Narrowing an assistant's tools or denying drive reads
therefore takes documents out of recall too, which keeps the drive's rule that
file access never arrives through the built-in bypass. Under the default unset
("ask") policy, the approval the user gives to the recall call is what admits
documents; ``docs/tools.md`` says so.

The messages of the conversation the call is made from are skipped while they
are still verbatim in the model's context (above the compaction watermark).
Recall is for what scrolled away, not what is on screen.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from .base import BaseTool

logger = logging.getLogger(__name__)

NO_USER = "Error: No user context available."
DEFAULT_LIMIT = 8
MAX_LIMIT = 20
MAX_PATTERN_CHARS = 500
MAX_QUERY_CHARS = 2000
#: How long a recall call waits for the embedding of its query.
EMBED_TIMEOUT_SECONDS = 15

SCOPES = ("all", "conversations", "documents")

DOCS_NOT_SEARCHED = (
    "Documents were not searched: drive_read is not available to this assistant."
)
DOCS_ONLY_REFUSED = (
    "Documents cannot be searched: drive_read is not available to this assistant. "
    "Ask about conversations instead."
)

_COMMON_PROPERTIES: Dict[str, Any] = {
    "scope": {
        "type": "string",
        "enum": list(SCOPES),
        "description": "What to search: past conversations, stored documents, or both (default).",
    },
    "in_conversation": {
        "type": "integer",
        "description": (
            "Search only this conversation (an id from history_list). Without it, "
            "every past conversation is searched except what is already in your context."
        ),
    },
    "after": {
        "type": "string",
        "description": "Only material from on or after this date (YYYY-MM-DD).",
    },
    "before": {
        "type": "string",
        "description": "Only material from on or before this date (YYYY-MM-DD).",
    },
    "limit": {
        "type": "integer",
        "description": f"How many passages to return (default {DEFAULT_LIMIT}, at most {MAX_LIMIT}).",
    },
}


def _parse_date(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return None


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def drive_allowed(args: Dict[str, Any]) -> bool:
    """Would ``drive_read`` be allowed to run for this caller?

    ``_available_tools`` is the agent's allowlist (None = every tool) and
    ``_context.tool_policies`` the user's stored decisions, both injected by
    ``BaseAgent.execute_tool``. Run outside an agent (tests), with neither
    present, the answer is yes.
    """
    allow = args.get("_available_tools")
    if allow is not None and "drive_read" not in allow:
        return False
    context = args.get("_context")
    policies = getattr(context, "tool_policies", None) or {}
    return policies.get("drive_read") != "deny"


def _format_hit(index: int, hit) -> str:
    if hit.source_kind == "message":
        title = f' "{hit.conversation_title}"' if hit.conversation_title else ""
        when = hit.created_at.strftime("%Y-%m-%d %H:%M") if hit.created_at else "unknown time"
        speaker = hit.speaker or "Unknown"
        source = (
            f"[{index}] Conversation #{hit.conversation_id}{title} — {speaker}, {when}, "
            f"message #{hit.message_id}"
        )
    else:
        where = ""
        if hit.page is not None:
            where = f", page {hit.page}"
        elif hit.start_line is not None:
            where = (
                f", line {hit.start_line}" if hit.end_line in (None, hit.start_line)
                else f", lines {hit.start_line}–{hit.end_line}"
            )
        path = hit.drive_path or f"(file #{hit.drive_node_id})"
        source = f"[{index}] {path}{where} — file #{hit.drive_node_id}"
    quoted = "\n".join(f"> {line}" for line in hit.content.splitlines()) or "> "
    return f"{source}\n{quoted}"


def format_hits(hits: List, footers: List[str]) -> str:
    parts = [_format_hit(i, hit) for i, hit in enumerate(hits, start=1)]
    body = "\n\n".join(parts)
    if footers:
        body = (body + "\n\n" if body else "") + "\n".join(footers)
    return body


class _RecallTool(BaseTool):
    built_in = True

    #: The property the query itself arrives in: ``pattern`` or ``query``.
    query_field = ""

    def _properties(self) -> Dict[str, Any]:
        raise NotImplementedError

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {**self._properties(), **_COMMON_PROPERTIES},
                    "required": [self.query_field],
                },
            },
        }

    def _filters(self, args: Dict[str, Any], include_drive: bool):
        from kurisuassistant.db.repositories import Filters

        scope = _as_text(args.get("scope")).strip().lower() or "all"
        if scope not in SCOPES:
            scope = "all"
        in_conversation = _as_int(args.get("in_conversation"), 0) or None
        return Filters(
            scope=scope,
            include_drive=include_drive,
            in_conversation=in_conversation,
            # `conversation_id` is the one the call is made from, injected by
            # BaseAgent.execute_tool — not a filter the model chose.
            current_conversation=_as_int(args.get("conversation_id"), 0) or None,
            after=_parse_date(args.get("after")),
            before=_parse_date(args.get("before")),
        )

    def _limit(self, args: Dict[str, Any]) -> int:
        return max(1, min(_as_int(args.get("limit"), DEFAULT_LIMIT), MAX_LIMIT))

    async def execute(self, args: Dict[str, Any]) -> str:
        user_id = args.get("user_id")
        if not user_id:
            return NO_USER
        query = _as_text(args.get(self.query_field)).strip()
        if not query:
            return f"Error: {self.query_field} is required."

        include_drive = drive_allowed(args)
        filters = self._filters(args, include_drive)
        if filters.scope == "documents" and not include_drive:
            return DOCS_ONLY_REFUSED

        footers: List[str] = []
        if not include_drive and filters.scope == "all":
            footers.append(DOCS_NOT_SEARCHED)
        try:
            hits, extra = await self._search(int(user_id), query, filters, self._limit(args))
        except _Refused as e:
            return str(e)
        footers = extra + footers
        if not hits:
            return f"{self._nothing(query)}" + ("\n\n" + "\n".join(footers) if footers else "")
        return format_hits(hits, footers)

    async def _search(self, user_id: int, query: str, filters, limit: int):
        raise NotImplementedError

    def _nothing(self, query: str) -> str:
        raise NotImplementedError


class _Refused(Exception):
    """A search that cannot run; the message is what the model reads."""


class RecallRegexTool(_RecallTool):
    """Exact-wording recall over conversations and documents."""

    name = "recall_regex"
    query_field = "pattern"
    description = (
        "Search everything the user said or wrote before — past conversations and the "
        "files in their drive — with a case-insensitive regular expression (POSIX ERE; a "
        "plain word or phrase works as a literal match). Use it when you know the wording: "
        "a name, a number, a distinctive phrase, a file's contents. Returns matching "
        "passages newest first, quoted verbatim, each with its source (conversation, "
        "speaker, time and message id — or file path and page/lines). When you answer "
        "from a passage, quote it and name the source. For meaning rather than wording, "
        "use recall_semantic; for the surrounding context, history_read or drive_read."
    )

    def _properties(self) -> Dict[str, Any]:
        return {
            "pattern": {
                "type": "string",
                "description": (
                    "Case-insensitive POSIX regular expression, e.g. 'passport', "
                    "'flight (to|from) Hanoi', '\\\\b2024-0[1-3]-\\\\d\\\\d\\\\b'."
                ),
            },
        }

    async def _search(self, user_id: int, pattern: str, filters, limit: int):
        from sqlalchemy.exc import DataError

        from kurisuassistant.db.repositories import PassageRepository
        from kurisuassistant.db.service import get_db_service

        if len(pattern) > MAX_PATTERN_CHARS:
            raise _Refused(f"Error: the pattern is longer than {MAX_PATTERN_CHARS} characters.")
        try:
            re.compile(pattern)
        except re.error as e:
            raise _Refused(f"Error: not a valid regular expression ({e}).")

        def _query(session):
            return PassageRepository(session).regex_search(user_id, pattern, filters, limit)

        try:
            hits = await get_db_service().execute(_query)
        except DataError:
            raise _Refused("Error: the database did not accept that regular expression.")
        return hits, []

    def _nothing(self, query: str) -> str:
        return f"No passage matches /{query}/."

    def describe_call(self, args: Dict[str, Any]) -> str:
        scope = _as_text(args.get("scope")).strip().lower() or "all"
        where = {"conversations": "past conversations", "documents": "stored documents"}.get(
            scope, "past conversations and documents"
        )
        return f"Recall by pattern /{_as_text(args.get('pattern'))}/ in {where}"


class RecallSemanticTool(_RecallTool):
    """Recall by meaning over conversations and documents."""

    name = "recall_semantic"
    query_field = "query"
    description = (
        "Search past conversations and the files in the user's drive by meaning: describe "
        "what you are looking for in a sentence and get the passages closest to it, even "
        "when the original used different words or another language. Use it when you do "
        "not know the exact wording, or when recall_regex found nothing. Returns passages "
        "closest first, quoted verbatim, each with its source (conversation, speaker, "
        "time and message id — or file path and page/lines). When you answer from a "
        "passage, quote it and name the source. For surrounding context use history_read "
        "or drive_read."
    )

    def _properties(self) -> Dict[str, Any]:
        return {
            "query": {
                "type": "string",
                "description": "What you are looking for, as a sentence or a question.",
            },
        }

    async def _search(self, user_id: int, query: str, filters, limit: int):
        from kurisuassistant.db.repositories import PassageRepository
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.utils import embeddings as embedding_service
        from kurisuassistant.utils.embeddings import EmbeddingDisabled, EmbeddingError

        if len(query) > MAX_QUERY_CHARS:
            query = query[:MAX_QUERY_CHARS]
        if not embedding_service.enabled():
            raise _Refused(
                "Error: semantic recall is switched off on this server (no embedding model). "
                "Use recall_regex."
            )
        try:
            vector = await asyncio.wait_for(
                asyncio.to_thread(embedding_service.embed_query, query),
                timeout=EMBED_TIMEOUT_SECONDS,
            )
        except EmbeddingDisabled:
            raise _Refused("Error: semantic recall is switched off on this server. Use recall_regex.")
        except (EmbeddingError, asyncio.TimeoutError) as e:
            logger.warning("recall_semantic could not embed the query: %s", e)
            raise _Refused(
                "Error: the embedding model is not answering right now, so nothing could be "
                "searched by meaning. Use recall_regex with the words you expect."
            )
        model = embedding_service.current_model()

        def _query(session):
            return PassageRepository(session).semantic_search(user_id, vector, model, filters, limit)

        hits = await get_db_service().execute(_query)
        return hits, []

    def _nothing(self, query: str) -> str:
        return (
            "Nothing close to that has been indexed yet. Passages are embedded in the "
            "background shortly after they are written; recall_regex sees them immediately."
        )

    def describe_call(self, args: Dict[str, Any]) -> str:
        scope = _as_text(args.get("scope")).strip().lower() or "all"
        where = {"conversations": "past conversations", "documents": "stored documents"}.get(
            scope, "past conversations and documents"
        )
        return f"Recall by meaning: '{_as_text(args.get('query'))}' in {where}"
