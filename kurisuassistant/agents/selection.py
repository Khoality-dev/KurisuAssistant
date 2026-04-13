"""Agent selection logic for routing conversations to the appropriate agent."""

import logging
from typing import List, Optional

from .base import AgentConfig

logger = logging.getLogger(__name__)


async def select_agent_for_frame(
    first_message: str,
    agents: List[AgentConfig],
    llm_provider,
    model_name: str = "gemma3:1b",
) -> AgentConfig:
    """Select the best agent to handle a new frame based on the first message.

    This is called ONCE when a new frame is created. The selected agent
    stays active for the entire frame unless a handoff occurs.

    Args:
        first_message: The user's first message in this frame
        agents: List of available main agents to choose from
        llm_provider: LLM provider instance for making the selection call
        model_name: Fast, small model for quick routing decisions

    Returns:
        The selected AgentConfig
    """
    if not agents:
        raise ValueError("No agents available for selection")

    # If only one agent, no need to call LLM
    if len(agents) == 1:
        logger.info(f"Single agent available, selecting: {agents[0].name}")
        return agents[0]

    # Build agent descriptions for the routing prompt
    agent_descriptions = "\n".join(
        f"- {agent.name}: {agent.description or 'General assistant'}"
        for agent in agents
    )

    prompt = f"""You are a routing assistant. Select the best agent to handle this conversation based on the user's message.

Available agents:
{agent_descriptions}

User's message: {first_message[:500]}

Reply with ONLY the agent name, nothing else. Do not include any explanation or punctuation."""

    try:
        # Make a quick, non-streaming LLM call
        response = await llm_provider.chat(
            model=model_name,
            messages=[{"role": "user", "content": prompt}],
            stream=False,
        )

        selected_name = response.message.content.strip().strip('"\'')
        logger.info(f"Routing LLM selected: '{selected_name}'")

        # Match to agent (case-insensitive)
        for agent in agents:
            if agent.name.lower() == selected_name.lower():
                return agent

        # If no exact match, try partial match
        for agent in agents:
            if selected_name.lower() in agent.name.lower():
                logger.warning(f"Partial match: '{selected_name}' -> '{agent.name}'")
                return agent

        # Fallback to first agent
        logger.warning(f"No match for '{selected_name}', falling back to '{agents[0].name}'")
        return agents[0]

    except Exception as e:
        logger.error(f"Agent selection failed: {e}, falling back to first agent")
        return agents[0]
