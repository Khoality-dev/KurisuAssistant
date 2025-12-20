"""Database service layer providing business logic and transaction management."""

import os
import re
import logging
from datetime import datetime
from typing import Optional, List
from alembic.config import Config
from alembic import command

from auth.password import hash_password, verify_password
from .session import get_session, engine
from .base import Base
from .repositories import UserRepository, ConversationRepository, MessageRepository, ChunkRepository

logger = logging.getLogger(__name__)


# ============================================================================
# Database Initialization
# ============================================================================

def init_db():
    """Initialize database using Alembic migrations."""
    logger.info("Initializing database with Alembic migrations...")

    try:
        # Run Alembic migrations to create/update schema
        # alembic.ini is in the db/ directory
        alembic_ini_path = os.path.join(os.path.dirname(__file__), "alembic.ini")
        alembic_cfg = Config(alembic_ini_path)

        # Set the script location relative to the db directory
        alembic_cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "alembic"))

        logger.info(f"Running Alembic migrations from: {alembic_ini_path}")

        # Run migrations
        command.upgrade(alembic_cfg, "head")
        logger.info("Alembic migrations completed successfully")

        # Ensure default admin account exists
        with get_session() as session:
            user_repo = UserRepository(session)
            if not user_repo.admin_exists():
                logger.info("Creating default admin account")
                user_repo.create_user("admin", hash_password("admin"))
            else:
                logger.info("Admin account already exists")

        logger.info("Database initialization completed successfully")
    except Exception as e:
        logger.error(f"Error running Alembic migrations: {e}")
        logger.warning("Falling back to manual schema creation...")
        # Fallback to manual table creation if needed
        _init_db_manual()


def _init_db_manual():
    """Fallback manual database initialization."""
    try:
        Base.metadata.create_all(bind=engine)

        with get_session() as session:
            user_repo = UserRepository(session)
            if not user_repo.admin_exists():
                user_repo.create_user("admin", hash_password("admin"))

        logger.info("Database initialized using manual schema creation")
    except Exception as e:
        logger.error(f"Error in manual database initialization: {e}")
        raise


# ============================================================================
# User Services
# ============================================================================

def authenticate_user(username: str, password: str) -> bool:
    """Authenticate a user with username and password."""
    try:
        with get_session() as session:
            user_repo = UserRepository(session)
            user = user_repo.get_by_username(username)
            if not user:
                return False
            return verify_password(password, user.password)
    except Exception as e:
        logger.error(f"Error authenticating user: {e}")
        return False


def create_user(username: str, password: str) -> None:
    """Create a new user account.

    Raises ValueError if the username already exists.
    """
    with get_session() as session:
        user_repo = UserRepository(session)
        user_repo.create_user(username, hash_password(password))


def admin_exists() -> bool:
    """Return True if the admin account already exists."""
    with get_session() as session:
        user_repo = UserRepository(session)
        return user_repo.admin_exists()


def get_user_preferences(username: str) -> tuple[str, str]:
    """Get both system prompt and preferred name for a specific user.

    Returns:
        tuple: (system_prompt, preferred_name)
    """
    with get_session() as session:
        user_repo = UserRepository(session)
        return user_repo.get_preferences(username)


def get_user_avatars(username: str) -> tuple[Optional[str], Optional[str]]:
    """Get avatar UUIDs for a specific user.

    Returns:
        tuple: (user_avatar_uuid, agent_avatar_uuid)
    """
    with get_session() as session:
        user_repo = UserRepository(session)
        return user_repo.get_avatars(username)


def update_user_preferences(username: str, system_prompt: Optional[str] = None, preferred_name: Optional[str] = None) -> None:
    """Update system prompt and/or preferred name for a specific user."""
    if system_prompt is None and preferred_name is None:
        return

    with get_session() as session:
        user_repo = UserRepository(session)
        user = user_repo.update_preferences(username, system_prompt, preferred_name)
        if not user:
            raise ValueError(f"User {username} not found")


def update_user_avatar(username: str, avatar_type: str, avatar_uuid: Optional[str]) -> None:
    """Update avatar UUID for a specific user.

    Args:
        username: The username to update
        avatar_type: Either 'user' or 'agent'
        avatar_uuid: The UUID of the uploaded avatar image, or None to clear
    """
    with get_session() as session:
        user_repo = UserRepository(session)
        user = user_repo.update_avatar(username, avatar_type, avatar_uuid)
        if not user:
            raise ValueError(f"User {username} not found")


# ============================================================================
# Conversation Services
# ============================================================================

def create_new_conversation(username: str) -> int:
    """Create a new empty conversation for the user and return its ID."""
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        conversation = conv_repo.create_conversation(username)
        return conversation.id


def get_conversations_list(username: str, limit: int = 50) -> list[dict]:
    """Return a list of conversations with basic info for a user."""
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        return conv_repo.list_by_user(username, limit)


def fetch_conversation(username: str, conversation_id: int, limit: int = 50, offset: int = 0) -> Optional[dict]:
    """Return a specific conversation for a user with paging support."""
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        msg_repo = MessageRepository(session)

        conversation = conv_repo.get_by_user_and_id(username, conversation_id)
        if not conversation:
            return None

        # Get total message count
        total_messages = msg_repo.count_by_conversation(username, conversation_id)

        # Get messages with paging
        messages = msg_repo.get_by_conversation(username, conversation_id, limit, offset)

        messages_array = [
            {
                "id": msg.id,
                "role": msg.role,
                "content": msg.message,
                "chunk_id": msg.chunk_id,
                "created_at": msg.created_at.isoformat(),
            }
            for msg in messages
        ]

        return {
            "id": conversation.id,
            "messages": messages_array,
            "created_at": conversation.created_at.isoformat(),
            "title": conversation.title or "",
            "total_messages": total_messages,
            "offset": offset,
            "limit": limit,
            "has_more": offset + len(messages_array) < total_messages,
        }


def update_conversation_title(username: str, title: str, conversation_id: Optional[int] = None) -> None:
    """Update the title of a specific conversation or the user's latest conversation."""
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        conv_repo.update_title(username, title, conversation_id)


def delete_conversation_by_id(username: str, conversation_id: int) -> bool:
    """Delete a specific conversation by ID for the given user.

    Cascade deletes will automatically remove chunks and messages.
    """
    with get_session() as session:
        conv_repo = ConversationRepository(session)

        # Delete conversation (cascade deletes chunks and messages automatically)
        return conv_repo.delete_by_user_and_id(username, conversation_id)


# ============================================================================
# Chunk Services
# ============================================================================

def create_chunk(username: str, conversation_id: int) -> int:
    """Create a new chunk in a conversation.

    Args:
        username: Username who owns the conversation
        conversation_id: Conversation ID

    Returns:
        ID of the created chunk

    Raises:
        ValueError: If conversation not found or doesn't belong to user
    """
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        chunk_repo = ChunkRepository(session)

        # Verify conversation ownership
        conversation = conv_repo.get_by_user_and_id(username, conversation_id)
        if not conversation:
            raise ValueError("Conversation not found")

        chunk = chunk_repo.create_chunk(conversation_id)
        return chunk.id


def get_chunk_by_id(username: str, conversation_id: int, chunk_id: int) -> Optional[dict]:
    """Get chunk ensuring it belongs to the specified conversation and user.

    Args:
        username: Username who owns the conversation
        conversation_id: Conversation ID
        chunk_id: Chunk ID

    Returns:
        Chunk dictionary or None if not found or doesn't belong to user
    """
    with get_session() as session:
        chunk_repo = ChunkRepository(session)
        conv_repo = ConversationRepository(session)

        chunk = chunk_repo.get_by_id(chunk_id)
        if not chunk or chunk.conversation_id != conversation_id:
            return None

        # Verify conversation belongs to user
        conversation = conv_repo.get_by_user_and_id(username, conversation_id)
        if not conversation:
            return None

        return {
            "id": chunk.id,
            "conversation_id": chunk.conversation_id,
            "created_at": chunk.created_at.isoformat(),
            "updated_at": chunk.updated_at.isoformat(),
        }


def get_latest_chunk(username: str, conversation_id: int) -> Optional[dict]:
    """Get the most recent chunk in a conversation.

    Args:
        username: Username who owns the conversation
        conversation_id: Conversation ID

    Returns:
        Latest chunk dictionary or None if no chunks exist
    """
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        chunk_repo = ChunkRepository(session)

        # Verify conversation ownership
        conversation = conv_repo.get_by_user_and_id(username, conversation_id)
        if not conversation:
            return None

        chunk = chunk_repo.get_latest_by_conversation(conversation_id)
        if not chunk:
            return None

        return {
            "id": chunk.id,
            "conversation_id": chunk.conversation_id,
            "created_at": chunk.created_at.isoformat(),
            "updated_at": chunk.updated_at.isoformat(),
        }


def get_chunks_by_conversation(username: str, conversation_id: int) -> Optional[list[dict]]:
    """Get all chunks for a conversation with message counts.

    Args:
        username: Username who owns the conversation
        conversation_id: Conversation ID

    Returns:
        List of chunk dictionaries with message counts, or None if conversation not found
    """
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        chunk_repo = ChunkRepository(session)

        # Verify conversation ownership
        conversation = conv_repo.get_by_user_and_id(username, conversation_id)
        if not conversation:
            return None

        return chunk_repo.list_by_conversation(conversation_id)


def get_chunk_messages(username: str, conversation_id: int, chunk_id: int) -> list[dict]:
    """Get all messages in a specific chunk.

    Args:
        username: Username who owns the conversation
        conversation_id: Conversation ID
        chunk_id: Chunk ID

    Returns:
        List of message dictionaries

    Raises:
        ValueError: If chunk doesn't belong to conversation or user
    """
    with get_session() as session:
        chunk_repo = ChunkRepository(session)
        msg_repo = MessageRepository(session)
        conv_repo = ConversationRepository(session)

        # Verify conversation ownership
        conversation = conv_repo.get_by_user_and_id(username, conversation_id)
        if not conversation:
            raise ValueError("Conversation not found")

        # Validate chunk access
        chunk = chunk_repo.get_by_id(chunk_id)
        if not chunk or chunk.conversation_id != conversation_id:
            raise ValueError("Invalid chunk or conversation")

        messages = msg_repo.get_by_chunk(username, chunk_id, limit=1000)  # No pagination for context

        return [
            {
                "id": msg.id,
                "role": msg.role,
                "content": msg.message,
                "created_at": msg.created_at.isoformat(),
            }
            for msg in messages
        ]


# ============================================================================
# Message Services
# ============================================================================

def create_message(username: str, message: dict, conversation_id: int, chunk_id: int) -> int:
    """Create a new message in the database.

    Args:
        username: Username who owns the message
        message: Message dictionary with role, content, created_at
        conversation_id: Conversation ID
        chunk_id: Chunk ID this message belongs to

    Returns:
        ID of the created message
    """
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        chunk_repo = ChunkRepository(session)
        msg_repo = MessageRepository(session)

        role = message.get("role")
        content = message.get("content", "")
        created_at = message.get("created_at")

        # Create new message
        new_message = msg_repo.create_message(
            role=role,
            username=username,
            message=content,
            chunk_id=chunk_id,
            created_at=created_at,
        )
        message_id = new_message.id

        # Update chunk's updated_at
        chunk = chunk_repo.get_by_id(chunk_id)
        if chunk:
            chunk_repo.update_timestamp(chunk)

        # Update conversation's updated_at
        conversation = conv_repo.get_by_id(conversation_id)
        if conversation:
            conv_repo.update_timestamp(conversation)

        return message_id


def fetch_message_by_id(username: str, message_id: int) -> Optional[dict]:
    """Fetch a specific message by its ID."""
    with get_session() as session:
        msg_repo = MessageRepository(session)
        message = msg_repo.get_by_user_and_id(username, message_id)

        if not message:
            return None

        return {
            "id": message.id,
            "role": message.role,
            "content": message.message,
            "conversation_id": message.conversation_id,
            "created_at": message.created_at.isoformat(),
        }


# ============================================================================
# Context Retrieval Services (for LLM context)
# ============================================================================

def retrieve_messages_by_date_range(
    conversation_id: int,
    start_date: datetime,
    end_date: datetime,
    limit: int = 100
) -> List[dict]:
    """Retrieve messages within a specific date range for a conversation.

    Args:
        conversation_id: Conversation ID
        start_date: Start date/time
        end_date: End date/time
        limit: Maximum number of messages to return (default: 100)

    Returns:
        List of message dictionaries with role, content, created_at
    """
    with get_session() as session:
        msg_repo = MessageRepository(session)
        return msg_repo.get_by_date_range(conversation_id, start_date, end_date, limit)


def retrieve_messages_by_regex(
    conversation_id: int,
    pattern: str,
    case_sensitive: bool = False,
    limit: int = 50
) -> List[dict]:
    """Search for messages matching a regular expression pattern.

    Args:
        conversation_id: Conversation ID
        pattern: Regular expression pattern to search for
        case_sensitive: Whether the search should be case sensitive (default: False)
        limit: Maximum number of messages to return (default: 50)

    Returns:
        List of matching message dictionaries

    Raises:
        ValueError: If regex pattern is invalid
    """
    # Compile regex pattern
    try:
        flags = 0 if case_sensitive else re.IGNORECASE
        compiled_pattern = re.compile(pattern, flags)
    except re.error as e:
        raise ValueError(f"Invalid regex pattern: {e}")

    with get_session() as session:
        msg_repo = MessageRepository(session)
        all_messages = msg_repo.get_all_for_conversation(conversation_id)

        # Filter results using regex
        matching_messages = []
        for msg in all_messages:
            if compiled_pattern.search(msg["content"]):
                matching_messages.append(msg)

                # Stop if we've reached the limit
                if len(matching_messages) >= limit:
                    break

        return matching_messages


def get_conversation_summary(conversation_id: int) -> Optional[dict]:
    """Get a summary of a conversation.

    Args:
        conversation_id: Conversation ID

    Returns:
        Dictionary with conversation metadata (id, title, message counts, timestamps)
        or None if conversation not found
    """
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        return conv_repo.get_summary(conversation_id)
