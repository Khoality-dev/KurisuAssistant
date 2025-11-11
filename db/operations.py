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

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ============================================================================
# Database Initialization
# ============================================================================

def init_db():
    """Initialize database using Alembic migrations."""
    try:
        # Run Alembic migrations to create/update schema
        alembic_cfg = Config(os.path.join(os.path.dirname(__file__), "alembic.ini"))
        command.upgrade(alembic_cfg, "head")

        # Ensure default admin account exists
        with get_session() as session:
            admin = session.query(User).filter_by(username="admin").first()
            if not admin:
                admin = User(username="admin", password=pwd_context.hash("admin"))
                session.add(admin)

        logger.info("Database initialized successfully using Alembic migrations")
    except Exception as e:
        logger.error(f"Error initializing database: {e}")
        # Fallback to manual table creation if needed
        _init_db_manual()


def _init_db_manual():
    """Fallback manual database initialization."""
    try:
        Base.metadata.create_all(bind=engine)

        with get_session() as session:
            admin = session.query(User).filter_by(username="admin").first()
            if not admin:
                admin = User(username="admin", password=pwd_context.hash("admin"))
                session.add(admin)

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
            user = session.query(User).filter_by(username=username).first()
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
        existing = session.query(User).filter_by(username=username).first()
        if existing:
            raise ValueError("User already exists")

        user = User(username=username, password=pwd_context.hash(password))
        session.add(user)


def admin_exists() -> bool:
    """Return True if the admin account already exists."""
    with get_session() as session:
        return session.query(User).filter_by(username="admin").first() is not None


def get_user_preferences(username: str) -> tuple[str, str]:
    """Get both system prompt and preferred name for a specific user.

    Returns:
        tuple: (system_prompt, preferred_name)
    """
    with get_session() as session:
        user = session.query(User).filter_by(username=username).first()
        if user:
            return user.system_prompt or "", user.preferred_name or ""
        return "", ""


def get_user_avatars(username: str) -> tuple[Optional[str], Optional[str]]:
    """Get avatar UUIDs for a specific user.

    Returns:
        tuple: (user_avatar_uuid, agent_avatar_uuid)
    """
    with get_session() as session:
        user = session.query(User).filter_by(username=username).first()
        if user:
            return user.user_avatar_uuid, user.agent_avatar_uuid
        return None, None


def update_user_preferences(username: str, system_prompt: Optional[str] = None, preferred_name: Optional[str] = None) -> None:
    """Update system prompt and/or preferred name for a specific user."""
    if system_prompt is None and preferred_name is None:
        return

    with get_session() as session:
        user = session.query(User).filter_by(username=username).first()
        if not user:
            raise ValueError(f"User {username} not found")

        if system_prompt is not None:
            user.system_prompt = system_prompt
        if preferred_name is not None:
            user.preferred_name = preferred_name


def update_user_avatar(username: str, avatar_type: str, avatar_uuid: Optional[str]) -> None:
    """Update avatar UUID for a specific user.

    Args:
        username: The username to update
        avatar_type: Either 'user' or 'agent'
        avatar_uuid: The UUID of the uploaded avatar image, or None to clear
    """
    if avatar_type not in ('user', 'agent'):
        raise ValueError("avatar_type must be 'user' or 'agent'")

    with get_session() as session:
        user = session.query(User).filter_by(username=username).first()
        if not user:
            raise ValueError(f"User {username} not found")

        if avatar_type == 'user':
            user.user_avatar_uuid = avatar_uuid
        else:
            user.agent_avatar_uuid = avatar_uuid


# ============================================================================
# Conversation Operations
# ============================================================================

def create_new_conversation(username: str) -> int:
    """Create a new empty conversation for the user and return its ID."""
    with get_session() as session:
        conversation = Conversation(username=username, title="New conversation")
        session.add(conversation)
        session.flush()  # Get the ID before commit
        return conversation.id


def get_conversations_list(username: str, limit: int = 50) -> list[dict]:
    """Return a list of conversations with basic info for a user."""
    with get_session() as session:
        conversations = (
            session.query(
                Conversation.id,
                Conversation.title,
                Conversation.created_at,
                Conversation.updated_at,
                func.count(Message.id).label('message_count')
            )
            .outerjoin(Message, (Conversation.id == Message.conversation_id) & (Message.username == username))
            .filter(Conversation.username == username)
            .group_by(Conversation.id, Conversation.title, Conversation.created_at, Conversation.updated_at)
            .order_by(desc(Conversation.updated_at))
            .limit(limit)
            .all()
        )

        result = []
        for conv in conversations:
            message_count = conv.message_count or 0
            latest_offset = ((message_count - 1) // 20) * 20 if message_count > 0 else 0

            result.append({
                "id": conv.id,
                "title": conv.title or "New conversation",
                "created_at": conv.created_at.isoformat(),
                "updated_at": conv.updated_at.isoformat() if conv.updated_at else conv.created_at.isoformat(),
                "message_count": message_count,
                "max_offset": latest_offset,
            })

        return result


def fetch_conversation(username: str, conversation_id: int, limit: int = 50, offset: int = 0) -> Optional[dict]:
    """Return a specific conversation for a user with paging support."""
    with get_session() as session:
        conversation = (
            session.query(Conversation)
            .filter_by(username=username, id=conversation_id)
            .first()
        )

        if not conversation:
            return None

        # Get total message count
        total_messages = (
            session.query(func.count(Message.id))
            .filter_by(username=username, conversation_id=conversation_id)
            .scalar()
        )

        # Get messages with paging
        messages = (
            session.query(Message)
            .filter_by(username=username, conversation_id=conversation_id)
            .order_by(Message.created_at)
            .limit(limit)
            .offset(offset)
            .all()
        )

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
        if conversation_id:
            conversation = (
                session.query(Conversation)
                .filter_by(username=username, id=conversation_id)
                .first()
            )
        else:
            conversation = (
                session.query(Conversation)
                .filter_by(username=username)
                .order_by(desc(Conversation.id))
                .first()
            )

        if conversation:
            conversation.title = title


def delete_conversation_by_id(username: str, conversation_id: int) -> bool:
    """Delete a specific conversation by ID for the given user."""
    with get_session() as session:
        # Delete messages first (cascade should handle this, but explicit is better)
        session.query(Message).filter_by(username=username, conversation_id=conversation_id).delete()

        # Delete conversation
        rows_affected = (
            session.query(Conversation)
            .filter_by(username=username, id=conversation_id)
            .delete()
        )

        return rows_affected > 0


# ============================================================================
# Message Operations
# ============================================================================

def add_messages(username: str, messages: list[dict], conversation_id: Optional[int] = None) -> tuple[int, list[int]]:
    """Add multiple messages to an existing conversation at once."""
    if not messages:
        return conversation_id or 0, []

    with get_session() as session:
        if conversation_id:
            conversation = (
                session.query(Conversation)
                .filter_by(username=username, id=conversation_id)
                .first()
            )
        else:
            conversation = (
                session.query(Conversation)
                .filter_by(username=username)
                .order_by(desc(Conversation.id))
                .first()
            )

        if not conversation:
            raise ValueError(f"No conversation found for user {username}")

        message_ids = []
        for msg in messages:
            message = Message(
                role=msg["role"],
                username=username,
                message=msg["content"],
                conversation_id=conversation.id,
                created_at=msg.get("created_at"),
                updated_at=msg.get("updated_at"),
            )
            session.add(message)
            session.flush()
            message_ids.append(message.id)

        # Update conversation's updated_at
        conversation.updated_at = datetime.utcnow()

        return conversation.id, message_ids


def upsert_streaming_message(username: str, message: dict, conversation_id: int) -> int:
    """Upsert a streaming message - create new or update existing based on role sequence."""
    with get_session() as session:
        # Get the last message for this conversation
        last_message = (
            session.query(Message)
            .filter_by(username=username, conversation_id=conversation_id)
            .order_by(desc(Message.created_at), desc(Message.id))
            .first()
        )

        role = message.get("role")
        content = message.get("content", "")
        created_at = message.get("created_at")
        updated_at = message.get("updated_at", created_at)

        if last_message and last_message.role == role:
            # Same role - concatenate content
            last_message.message += content
            last_message.updated_at = updated_at
            message_id = last_message.id
        else:
            # Different role or no previous message - create new
            new_message = Message(
                role=role,
                username=username,
                message=content,
                conversation_id=conversation_id,
                created_at=created_at,
                updated_at=updated_at,
            )
            session.add(new_message)
            session.flush()
            message_id = new_message.id

        # Update conversation's updated_at
        conversation = session.query(Conversation).filter_by(id=conversation_id).first()
        if conversation:
            conversation.updated_at = datetime.utcnow()

        return message_id


def fetch_message_by_id(username: str, message_id: int) -> Optional[dict]:
    """Fetch a specific message by its ID."""
    with get_session() as session:
        message = (
            session.query(Message)
            .filter_by(id=message_id, username=username)
            .first()
        )

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


