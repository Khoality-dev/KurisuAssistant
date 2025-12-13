import os
import logging
from datetime import datetime
from typing import Optional
from passlib.context import CryptContext
from sqlalchemy import func, desc
from alembic.config import Config
from alembic import command

from .session import get_session, engine
from .models import User, Conversation, Message
from .base import Base
from .repositories import UserRepository, ConversationRepository, MessageRepository

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


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
                user_repo.create_user("admin", pwd_context.hash("admin"))
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
                user_repo.create_user("admin", pwd_context.hash("admin"))

        logger.info("Database initialized using manual schema creation")
    except Exception as e:
        logger.error(f"Error in manual database initialization: {e}")
        raise


# ============================================================================
# User Operations
# ============================================================================

def authenticate_user(username: str, password: str) -> bool:
    """Authenticate a user with username and password."""
    try:
        with get_session() as session:
            user_repo = UserRepository(session)
            user = user_repo.get_by_username(username)
            if not user:
                return False
            return pwd_context.verify(password, user.password)
    except Exception as e:
        logger.error(f"Error authenticating user: {e}")
        return False


def create_user(username: str, password: str) -> None:
    """Create a new user account.

    Raises ValueError if the username already exists.
    """
    with get_session() as session:
        user_repo = UserRepository(session)
        user_repo.create_user(username, pwd_context.hash(password))


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
# Conversation Operations
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
                "created_at": msg.created_at.isoformat(),
                "updated_at": msg.updated_at.isoformat() if msg.updated_at else msg.created_at.isoformat(),
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
    """Delete a specific conversation by ID for the given user."""
    with get_session() as session:
        msg_repo = MessageRepository(session)
        conv_repo = ConversationRepository(session)

        # Delete messages first (cascade should handle this, but explicit is better)
        msg_repo.delete_by_conversation(username, conversation_id)

        # Delete conversation
        return conv_repo.delete_by_user_and_id(username, conversation_id)


# ============================================================================
# Message Operations
# ============================================================================

def add_messages(username: str, messages: list[dict], conversation_id: Optional[int] = None) -> tuple[int, list[int]]:
    """Add multiple messages to an existing conversation at once."""
    if not messages:
        return conversation_id or 0, []

    with get_session() as session:
        conv_repo = ConversationRepository(session)
        msg_repo = MessageRepository(session)

        if conversation_id:
            conversation = conv_repo.get_by_user_and_id(username, conversation_id)
        else:
            conversation = conv_repo.get_latest_by_user(username)

        if not conversation:
            raise ValueError(f"No conversation found for user {username}")

        message_ids = []
        for msg in messages:
            message = msg_repo.create_message(
                role=msg["role"],
                username=username,
                message=msg["content"],
                conversation_id=conversation.id,
                created_at=msg.get("created_at"),
                updated_at=msg.get("updated_at"),
            )
            message_ids.append(message.id)

        # Update conversation's updated_at
        conv_repo.update_timestamp(conversation)

        return conversation.id, message_ids


def upsert_streaming_message(username: str, message: dict, conversation_id: int) -> int:
    """Upsert a streaming message - create new or update existing based on role sequence."""
    with get_session() as session:
        conv_repo = ConversationRepository(session)
        msg_repo = MessageRepository(session)

        # Get the last message for this conversation
        last_message = msg_repo.get_latest_by_conversation(username, conversation_id)

        role = message.get("role")
        content = message.get("content", "")
        created_at = message.get("created_at")
        updated_at = message.get("updated_at", created_at)

        if last_message and last_message.role == role:
            # Same role - concatenate content
            msg_repo.append_to_message(last_message, content)
            message_id = last_message.id
        else:
            # Different role or no previous message - create new
            new_message = msg_repo.create_message(
                role=role,
                username=username,
                message=content,
                conversation_id=conversation_id,
                created_at=created_at,
                updated_at=updated_at,
            )
            message_id = new_message.id

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
            "updated_at": message.updated_at.isoformat() if message.updated_at else message.created_at.isoformat(),
        }


