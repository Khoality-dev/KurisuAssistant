"""System prompt building utilities."""

import datetime
from typing import Optional, List, Dict

DEFAULT_SYSTEM_PROMPT = """"""


def build_system_messages(
    user_system_prompt: str,
    preferred_name: Optional[str] = None
) -> List[Dict]:
    """Build system messages combining global and user-specific prompts."""
    global_prompt = DEFAULT_SYSTEM_PROMPT
    global_prompt += f"\n\nCurrent time: {datetime.datetime.utcnow().isoformat()}"

    # Build user-specific prompt
    user_prompt_content = user_system_prompt
    if preferred_name:
        user_prompt_content += f"\n\nThe user prefers to be called: {preferred_name}"

    return [
        {"role": "system", "content": global_prompt},
        {"role": "system", "content": user_prompt_content},
    ]
