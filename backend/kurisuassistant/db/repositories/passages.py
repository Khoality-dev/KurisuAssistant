"""Repository for the retrieval index — the ``passages`` table (#6).

Every read here takes a ``user_id`` and filters on it, for the same reason the
drive repository does: this is the one place that answers "whose passage is
this", so neither recall tool can be talked into another account's history.

Two searches, one table:

* ``regex_search`` — a case-insensitive POSIX regular expression over the
  passage text (Postgres ``~*``), newest first. Exact wording, no ranking.
* ``semantic_search`` — cosine distance between a query vector and the stored
  embeddings, closest first, restricted to rows embedded by the model the
  query was embedded with. Vectors from two models are never compared.

Both return ``Hit`` objects already joined to what a citation needs: the
message's speaker and time and its conversation's title, or the drive node's
full path. The writes are what the indexer (``utils/indexing.py``) uses to keep
the table in step with messages and drive files.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func, insert, or_, select, update
from sqlalchemy.orm import Session

from ..models import Conversation, DriveNode, Message, Passage
from .base import BaseRepository
from .drive import DriveNodeRepository

#: After this many deterministic refusals a passage stays keyword-only. The
#: partial index ``ix_passages_pending_embed`` is defined with the same number,
#: so the backlog query below is exactly what that index covers.
MAX_EMBED_ATTEMPTS = 5


@dataclass(frozen=True)
class Hit:
    passage_id: int
    source_kind: str
    content: str
    ordinal: int
    page: Optional[int]
    start_line: Optional[int]
    end_line: Optional[int]
    # message passages
    conversation_id: Optional[int] = None
    conversation_title: Optional[str] = None
    message_id: Optional[int] = None
    speaker: Optional[str] = None
    role: Optional[str] = None
    created_at: Optional[datetime] = None
    # drive passages
    drive_node_id: Optional[int] = None
    drive_path: Optional[str] = None
    # semantic only
    distance: Optional[float] = None


@dataclass(frozen=True)
class Filters:
    """What both searches accept besides the query itself."""

    #: ``"all"``, ``"conversations"`` or ``"documents"``.
    scope: str = "all"
    #: Whether drive passages may be returned at all (the ``drive_read`` gate).
    include_drive: bool = True
    #: Only this conversation.
    in_conversation: Optional[int] = None
    #: The conversation the caller is in. Its messages that are still verbatim
    #: in the model's context (id above the compaction watermark) are skipped —
    #: recall is for what scrolled away, not what is on screen.
    current_conversation: Optional[int] = None
    after: Optional[datetime] = None
    before: Optional[datetime] = None


class PassageRepository(BaseRepository[Passage]):
    """Repository for Passage model operations."""

    def __init__(self, session: Session):
        super().__init__(Passage, session)

    # ── writes (the indexer) ───────────────────────────────────────────────

    def insert_many(self, rows: Sequence[dict]) -> int:
        """Bulk insert; ``rows`` are column dicts. Returns how many went in."""
        if not rows:
            return 0
        self.session.execute(insert(Passage), list(rows))
        return len(rows)

    def delete_for_drive_node(self, node_id: int) -> int:
        return (
            self.session.query(Passage)
            .filter(Passage.drive_node_id == node_id)
            .delete(synchronize_session=False)
        )

    def pending_embed_ids(self, limit: int, exclude: Iterable[int] = ()) -> List[int]:
        """Passages with no vector yet, oldest first. This predicate is the
        partial index's, word for word."""
        q = (
            self.session.query(Passage.id)
            .filter(Passage.embedding.is_(None), Passage.embed_attempts < MAX_EMBED_ATTEMPTS)
        )
        exclude = list(exclude)
        if exclude:
            q = q.filter(Passage.id.notin_(exclude))
        return [row[0] for row in q.order_by(Passage.id).limit(limit).all()]

    def contents_for(self, ids: Sequence[int]) -> List[Tuple[int, str]]:
        """``(id, content)`` for the rows that still have no embedding."""
        if not ids:
            return []
        rows = (
            self.session.query(Passage.id, Passage.content)
            .filter(Passage.id.in_(list(ids)), Passage.embedding.is_(None))
            .order_by(Passage.id)
            .all()
        )
        return [(r[0], r[1]) for r in rows]

    def mark_embedded(self, vectors: Sequence[Tuple[int, Sequence[float]]], model: str) -> None:
        for passage_id, vector in vectors:
            self.session.execute(
                update(Passage)
                .where(Passage.id == passage_id)
                .values(embedding=list(vector), embedding_model=model, embed_attempts=0)
            )

    def bump_attempts(self, ids: Sequence[int]) -> None:
        if not ids:
            return
        self.session.execute(
            update(Passage)
            .where(Passage.id.in_(list(ids)))
            .values(embed_attempts=Passage.embed_attempts + 1)
        )

    def reset_stale_model(self, model: str, limit: int) -> int:
        """Forget up to ``limit`` vectors made by a model other than ``model``,
        so the backlog re-embeds them. Returns how many were reset."""
        stale = (
            select(Passage.id)
            .where(Passage.embedding.isnot(None), Passage.embedding_model.is_distinct_from(model))
            .limit(limit)
        )
        result = self.session.execute(
            update(Passage)
            .where(Passage.id.in_(stale))
            .values(embedding=None, embedding_model=None, embed_attempts=0)
        )
        return result.rowcount or 0

    # ── reads (the tools) ──────────────────────────────────────────────────

    def _base(self, user_id: int, filters: Filters):
        q = (
            self.session.query(
                Passage,
                Message.name,
                Message.role,
                Message.created_at,
                Conversation.title,
                DriveNode.updated_at,
            )
            .outerjoin(Message, Passage.message_id == Message.id)
            .outerjoin(Conversation, Passage.conversation_id == Conversation.id)
            .outerjoin(DriveNode, Passage.drive_node_id == DriveNode.id)
            .filter(Passage.user_id == user_id)
        )
        scope = filters.scope
        if not filters.include_drive and scope == "documents":
            # Nothing can match: the caller asked for documents it may not see.
            return q.filter(False)
        if scope == "conversations" or not filters.include_drive:
            q = q.filter(Passage.source_kind == "message")
        elif scope == "documents":
            q = q.filter(Passage.source_kind == "drive")
        if filters.in_conversation is not None:
            q = q.filter(Passage.conversation_id == filters.in_conversation)
        elif filters.current_conversation is not None:
            q = q.filter(or_(
                Passage.conversation_id.is_(None),
                Passage.conversation_id != filters.current_conversation,
                Message.id <= Conversation.compacted_up_to_id,
            ))
        when = func.coalesce(Message.created_at, DriveNode.updated_at)
        if filters.after is not None:
            q = q.filter(when >= filters.after)
        if filters.before is not None:
            q = q.filter(when <= filters.before)
        return q

    def _hits(self, user_id: int, rows, distances: Optional[Sequence[float]] = None) -> List[Hit]:
        node_ids = [r[0].drive_node_id for r in rows if r[0].drive_node_id is not None]
        paths = DriveNodeRepository(self.session).paths_for(user_id, node_ids) if node_ids else {}
        hits = []
        for index, row in enumerate(rows):
            passage, name, role, created_at, title, node_updated = row
            speaker = name or (role.capitalize() if role else None)
            hits.append(Hit(
                passage_id=passage.id,
                source_kind=passage.source_kind,
                content=passage.content,
                ordinal=passage.ordinal,
                page=passage.page,
                start_line=passage.start_line,
                end_line=passage.end_line,
                conversation_id=passage.conversation_id,
                conversation_title=title,
                message_id=passage.message_id,
                speaker=speaker,
                role=role,
                created_at=created_at or node_updated,
                drive_node_id=passage.drive_node_id,
                drive_path=paths.get(passage.drive_node_id) if passage.drive_node_id else None,
                distance=float(distances[index]) if distances is not None else None,
            ))
        return hits

    def regex_search(self, user_id: int, pattern: str, filters: Filters, limit: int) -> List[Hit]:
        """Case-insensitive POSIX regex over the text, newest first.

        An invalid pattern raises the database's own error (a
        ``sqlalchemy.exc.DataError``); the tool turns it into a sentence.
        """
        when = func.coalesce(Message.created_at, DriveNode.updated_at)
        rows = (
            self._base(user_id, filters)
            .filter(Passage.content.op("~*")(pattern))
            .order_by(when.desc().nullslast(), Passage.id.desc())
            .limit(limit)
            .all()
        )
        return self._hits(user_id, rows)

    def semantic_search(
        self, user_id: int, vector: Sequence[float], model: str, filters: Filters, limit: int,
    ) -> List[Hit]:
        """Closest passages by cosine distance, among those embedded by ``model``."""
        distance = Passage.embedding.cosine_distance(list(vector)).label("distance")
        rows = (
            self._base(user_id, filters)
            .add_columns(distance)
            .filter(Passage.embedding_model == model)
            .order_by(distance, Passage.id)
            .limit(limit)
            .all()
        )
        plain = [row[:-1] for row in rows]
        return self._hits(user_id, plain, [row[-1] for row in rows])

    def count_for_user(self, user_id: int) -> Dict[str, int]:
        rows = (
            self.session.query(Passage.source_kind, func.count(Passage.id))
            .filter(Passage.user_id == user_id)
            .group_by(Passage.source_kind)
            .all()
        )
        return {kind: int(n) for kind, n in rows}
