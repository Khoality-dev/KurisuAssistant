"""Task dataclasses for background worker processing."""

from dataclasses import dataclass


@dataclass
class ConsolidateMemoryTask:
    """Consolidate an agent's memory from a conversation's messages.

    Fired by the conversation-idle scanner (see ``BackgroundService``).
    Runs after a conversation has been idle past the configured threshold.
    """
    user_id: int
    agent_id: int
    conversation_id: int
    model_name: str
    api_url: str | None = None
    provider_type: str = "ollama"
    api_key: str | None = None
