"""Main-agent selection for new conversations.

Runs once when a conversation has no ``main_agent_id`` yet. First
message is scanned for any enabled main agent's ``trigger_word``
(case-insensitive, word-boundary); if none matches, a random main
agent is chosen. No LLM call — this is deterministic + cheap.
"""

import logging
import random
import re
from typing import List, Optional

from .base import AgentConfig

logger = logging.getLogger(__name__)


def _normalize_trigger(trigger: Optional[str]) -> Optional[str]:
    if trigger is None:
        return None
    trigger = trigger.strip()
    return trigger or None


def pick_main_agent(first_message: str, main_agents: List[AgentConfig]) -> AgentConfig:
    """Pick a main agent for a conversation.

    Order: first-matching trigger word wins; otherwise random choice.
    Raises ``ValueError`` if ``main_agents`` is empty.
    """
    if not main_agents:
        raise ValueError("No main agents available for selection")

    text = (first_message or "")
    if text:
        for agent in main_agents:
            trigger = _normalize_trigger(agent.trigger_word)
            if not trigger:
                continue
            pattern = r"\b" + re.escape(trigger) + r"\b"
            if re.search(pattern, text, re.IGNORECASE):
                logger.info("Matched trigger word '%s' → agent '%s'", trigger, agent.name)
                return agent

    chosen = random.choice(main_agents)
    logger.info("No trigger word match — randomly picked '%s'", chosen.name)
    return chosen
