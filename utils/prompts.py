"""System prompt building utilities."""

import datetime
import logging
from pathlib import Path
from typing import Optional, List, Dict

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = """You are a helpful AI assistant. Be concise, accurate, and helpful in your responses."""


def _load_global_system_prompt() -> str:
    """Load the global system prompt from SYSTEM_PROMPT.md at project root."""
    try:
        project_root = Path(__file__).parent.parent
        prompt_path = project_root / 'SYSTEM_PROMPT.md'
        with open(prompt_path, 'r', encoding='utf-8') as f:
            return f.read().strip()
    except Exception as e:
        logger.warning(f"Could not load SYSTEM_PROMPT.md, using default: {e}")
        return DEFAULT_SYSTEM_PROMPT


def build_system_messages(
    user_system_prompt: str,
    preferred_name: Optional[str] = None
) -> List[Dict]:
    """Build system messages combining global and user-specific prompts."""
    # Load global prompt and add current datetime
    global_prompt = _load_global_system_prompt()
    global_prompt += f"\n\nCurrent time: {datetime.datetime.utcnow().isoformat()}"

    # Build user-specific prompt
    user_prompt_content = user_system_prompt
    if preferred_name:
        user_prompt_content += f"\n\nThe user prefers to be called: {preferred_name}"

    return [
        {"role": "system", "content": global_prompt},
        {"role": "system", "content": user_prompt_content},
    ]
