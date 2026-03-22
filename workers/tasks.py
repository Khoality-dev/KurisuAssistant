"""Task dataclasses for background worker processing."""

from dataclasses import dataclass


@dataclass
class SummarizeFrameTask:
    """Summarize a conversation frame using an LLM."""
    frame_id: int
    model_name: str
    api_url: str | None = None


@dataclass
class ConsolidateMemoryTask:
    """Consolidate agent memory + notes from conversation frames."""
    user_id: int
    agent_id: int
    frame_ids: list[int]
    model_name: str
    api_url: str | None = None
