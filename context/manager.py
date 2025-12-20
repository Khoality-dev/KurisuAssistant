"""Context manager for loading conversation messages from database.

This module provides stateless helper functions for retrieving conversation
context from the database. It acts as a thin wrapper around db.services.
"""

from typing import List, Dict, Optional
from db import services


def get_chunk_messages(
    username: str,
    conversation_id: Optional[int],
    chunk_id: Optional[int]
) -> List[Dict]:
    """Load messages from a specific chunk.

    This is a stateless function that queries the database on each call.
    No in-memory caching is performed.

    Args:
        username: Username for authorization
        conversation_id: Conversation ID (returns empty list if None)
        chunk_id: Chunk ID (returns empty list if None)

    Returns:
        List of message dicts with keys: role, content, created_at, id
        Returns empty list if conversation_id or chunk_id is None
    """
    # Return empty context if no chunk specified
    if conversation_id is None or chunk_id is None:
        return []

    try:
        messages = services.get_chunk_messages(username, conversation_id, chunk_id)

        # Convert to standardized format
        formatted_messages = []
        for msg in messages:
            formatted_messages.append({
                "role": msg["role"],
                "content": msg["content"],
                "created_at": msg["created_at"],
                "message_id": msg["id"]
            })

        return formatted_messages

    except Exception as e:
        print(f"Error loading chunk messages: {e}")
        # Return empty context if loading fails
        return []
