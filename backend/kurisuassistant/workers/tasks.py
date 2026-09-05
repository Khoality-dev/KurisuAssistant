"""Task dataclasses for background worker processing."""

from dataclasses import dataclass


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
