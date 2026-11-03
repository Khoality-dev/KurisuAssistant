"""Task dataclasses for background worker processing."""

from dataclasses import dataclass, field
from typing import List


@dataclass
class ConsolidateMemoryTask:
    """Consolidate a user's assistant memory from a conversation's messages.

    Fired by the conversation-idle scanner (see ``BackgroundService``).
    Runs after a conversation has been idle past the configured threshold.

    There is no agent id: memory is one document per user, held on that user's
    single ``Assistant`` row, so the target is derived from ``user_id``.
    """
    user_id: int
    conversation_id: int
    model_name: str
    api_url: str | None = None
    provider_type: str = "ollama"
    api_key: str | None = None


@dataclass
class ChunkConversationTask:
    """Turn a conversation's new messages into passages (#6).

    Submitted by the chat handler as a turn ends and by the index scanner for
    anything that submit missed. Idempotent: the watermark on the conversation
    row says where to start.
    """
    user_id: int
    conversation_id: int


@dataclass
class ChunkDriveFileTask:
    """Extract and chunk one drive file (#6).

    Submitted by the drive router and the ``drive_write`` tool after a write,
    and by the index scanner for any file whose checksum differs from the one
    last indexed.
    """
    user_id: int
    node_id: int


@dataclass
class EmbedPassagesTask:
    """Embed a batch of passages that have no vector yet (#6)."""
    passage_ids: List[int] = field(default_factory=list)
