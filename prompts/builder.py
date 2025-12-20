"""System prompt building utilities.

This module provides functions to build system prompts for the LLM by combining:
- Global system prompt from AGENT.md
- User-specific system prompt
- User's preferred name
- Current timestamp
"""

import os
import datetime
from typing import Optional, List, Dict


def load_global_system_prompt() -> str:
    """Load the global system prompt from AGENT.md file.

    Returns:
        str: Content of AGENT.md, or empty string if file cannot be loaded
    """
    try:
        agent_md_path = os.path.join(
            os.path.dirname(__file__),
            'AGENT.md'
        )
        with open(agent_md_path, 'r', encoding='utf-8') as f:
            return f.read().strip()
    except Exception as e:
        print(f"Warning: Could not load global system prompt from AGENT.md: {e}")
        return ""


def build_system_messages(
    user_system_prompt: str,
    preferred_name: Optional[str] = None
) -> List[Dict]:
    """Build system messages combining global and user-specific prompts.

    Args:
        user_system_prompt: User's custom system prompt
        preferred_name: User's preferred name (optional)

    Returns:
        List of message dicts with role="system" and content
    """
    global_prompt = load_global_system_prompt()

    # Build user-specific prompt with preferred name and timestamp
    user_prompt_content = user_system_prompt

    if preferred_name:
        user_prompt_content += f"\n\nThe user prefers to be called: {preferred_name}"

    user_prompt_content += f"\n\nCurrent time is {datetime.datetime.utcnow().isoformat()}"

    # Return list of system messages
    return [
        {"role": "system", "content": global_prompt},
        {"role": "system", "content": user_prompt_content},
    ]
