import os
import psycopg2
import json
import datetime
import hashlib
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://kurisu:kurisu@localhost:5432/kurisu")


def get_connection():
    return psycopg2.connect(DATABASE_URL)


def get_db_connection():
    """Alias for get_connection() for consistency with Agent class expectations."""
    return get_connection()


def generate_message_hash(role: str, content: str, username: str, conversation_id: int, created_at: str) -> str:
    """Generate a unique hash for a message based on its content and metadata."""
    message_data = f"{role}:{content}:{username}:{conversation_id}:{created_at}"
    return hashlib.sha256(message_data.encode()).hexdigest()[:16]


def init_db():
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            system_prompt TEXT DEFAULT ''
        )
        """
    )
    # ensure default admin account
    cur.execute(
        "INSERT INTO users (username, password) VALUES (%s, %s) ON CONFLICT (username) DO NOTHING",
        ("admin", pwd_context.hash("admin")),
    )
    # Conversations table for conversation metadata (no messages column)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS conversations (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT DEFAULT 'New conversation',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    # Create messages table with each message as a row
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            role TEXT NOT NULL,
            username TEXT NOT NULL,
            message TEXT NOT NULL,
            conversation_id INTEGER,
            message_hash TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    
    # Create index for better query performance on messages table
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_username ON messages(username)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(message_hash)"
    )
    conn.commit()
    cur.close()
    conn.close()


def add_messages(
    username: str,
    messages: list,
    conversation_id: int | None = None,
) -> int:
    """Add multiple messages to an existing conversation at once.

    Parameters
    ----------
    username : str
        The username of the conversation owner
    messages : list
        List of message dictionaries with 'role', 'content', and optional fields
    conversation_id : int | None
        If provided, add messages to this specific conversation.
        If None, add to the user's latest conversation.
    
    Returns
    -------
    int
        The conversation ID that the messages were added to.
        
    Raises
    ------
    ValueError
        If no conversation exists for the user.
    """
    if not messages:
        return conversation_id or 0
        
    conn = get_connection()
    cur = conn.cursor()
    
    if conversation_id:
        cur.execute(
            "SELECT id FROM conversations WHERE username=%s AND id=%s",
            (username, conversation_id),
        )
    else:
        cur.execute(
            "SELECT id FROM conversations WHERE username=%s ORDER BY id DESC LIMIT 1",
            (username,),
        )
    
    row = cur.fetchone()
    if not row:
        cur.close()
        conn.close()
        raise ValueError(f"No conversation found for user {username}")
    
    conv_id = row[0]
    
    # Insert all new messages into the messages table
    for msg in messages:
        created_at = msg.get("created_at")
        updated_at = msg.get("updated_at")
        message_hash = msg.get("message_hash")
        
        cur.execute(
            "INSERT INTO messages (role, username, message, conversation_id, message_hash, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (msg["role"], username, msg["content"], conv_id, message_hash, created_at, updated_at)
        )
    
    # Update conversation's updated_at timestamp
    cur.execute(
        "UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=%s",
        (conv_id,)
    )
    conn.commit()
    cur.close()
    conn.close()
    return conv_id




def fetch_conversation(username: str, conversation_id: int, limit: int = 50, offset: int = 0):
    """Return a specific conversation for a user with paging support.
    
    Messages are always returned in chronological order (oldest first) within the page.
    Use offset to get different ranges of messages:
    - offset=0: oldest messages
    - offset=total_messages-5: newest messages
    
    Parameters
    ----------
    username : str
        The username of the conversation owner
    conversation_id : int
        The ID of the conversation to fetch
    limit : int, optional
        Maximum number of messages to return (default: 50)
    offset : int, optional
        Number of messages to skip from the beginning (default: 0)
    
    Returns
    -------
    dict or None
        Conversation data with paged messages, or None if not found
    """
    conn = get_connection()
    cur = conn.cursor()
    
    # Get conversation metadata
    cur.execute(
        "SELECT id, created_at, title FROM conversations WHERE username=%s AND id=%s",
        (username, conversation_id),
    )
    conv_row = cur.fetchone()
    
    if not conv_row:
        cur.close()
        conn.close()
        return None
    
    # Get total message count for this conversation
    cur.execute(
        "SELECT COUNT(*) FROM messages WHERE username=%s AND conversation_id=%s",
        (username, conversation_id),
    )
    total_messages = cur.fetchone()[0]
    
    # Always order by created_at ASC (chronological order)
    # Get messages for this conversation with paging
    cur.execute(
        "SELECT id, role, message, created_at, message_hash, updated_at FROM messages WHERE username=%s AND conversation_id=%s ORDER BY created_at ASC LIMIT %s OFFSET %s",
        (username, conversation_id, limit, offset),
    )
    message_rows = cur.fetchall()
    cur.close()
    conn.close()
    
    # Format messages to match expected structure
    messages_array = []
    for msg_row in message_rows:
        messages_array.append({
            "id": msg_row[0],
            "role": msg_row[1],
            "content": msg_row[2],
            "created_at": msg_row[3].isoformat(),
            "message_hash": msg_row[4],
            "updated_at": msg_row[5].isoformat() if msg_row[5] else msg_row[3].isoformat(),
        })
    
    return {
        "id": conv_row[0],
        "messages": messages_array,
        "created_at": conv_row[1].isoformat(),
        "title": conv_row[2] or "",
        "total_messages": total_messages,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(messages_array) < total_messages,
    }


def update_conversation_title(username: str, title: str, conversation_id: int = None) -> None:
    """Update the title of a specific conversation or the user's latest conversation."""
    conn = get_connection()
    cur = conn.cursor()
    
    if conversation_id:
        cur.execute(
            "UPDATE conversations SET title = %s WHERE username = %s AND id = %s",
            (title, username, conversation_id)
        )
    else:
        cur.execute(
            "UPDATE conversations SET title = %s WHERE username = %s AND id = (SELECT MAX(id) FROM conversations WHERE username = %s)",
            (title, username, username)
        )
    
    conn.commit()
    cur.close()
    conn.close()


def delete_conversation_by_id(username: str, conversation_id: int) -> bool:
    """Delete a specific conversation by ID for the given user. Returns True if deleted, False if not found."""
    conn = get_connection()
    cur = conn.cursor()
    
    # First delete all messages in this conversation
    cur.execute(
        "DELETE FROM messages WHERE username = %s AND conversation_id = %s",
        (username, conversation_id)
    )
    
    # Then delete the conversation itself
    cur.execute(
        "DELETE FROM conversations WHERE username = %s AND id = %s",
        (username, conversation_id)
    )
    rows_affected = cur.rowcount
    conn.commit()
    cur.close()
    conn.close()
    return rows_affected > 0


def get_conversations_list(username: str, limit: int = 50):
    """Return a list of conversations with basic info (id, title, created_at, message_count, latest_offset) for a user."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """SELECT c.id, c.title, c.created_at, c.updated_at,
                  COUNT(m.id) as message_count
           FROM conversations c
           LEFT JOIN messages m ON c.id = m.conversation_id AND m.username = c.username
           WHERE c.username = %s 
           GROUP BY c.id, c.title, c.created_at, c.updated_at
           ORDER BY c.updated_at DESC 
           LIMIT %s""",
        (username, limit),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    
    conversations = []
    for r in rows:
        message_count = r[4] or 0
        # Calculate latest_offset: where the most recent 5 messages would start
        # For newest messages, we want the last 5, so offset = max(0, total - 5)
        latest_offset = max(0, message_count - 5) if message_count > 0 else 0
        
        conversations.append({
            "id": r[0],
            "title": r[1] or "New conversation",
            "created_at": r[2].isoformat(),
            "updated_at": r[3].isoformat() if r[3] else r[2].isoformat(),
            "message_count": message_count,
            "latest_offset": latest_offset,
        })
    
    return conversations


def create_new_conversation(username: str) -> int:
    """Create a new empty conversation for the user and return its ID."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO conversations (username, title) VALUES (%s, %s) RETURNING id",
        (username, "New conversation"),
    )
    conversation_id = cur.fetchone()[0]
    conn.commit()
    cur.close()
    conn.close()
    return conversation_id


def create_user(username: str, password: str) -> None:
    """Create a new user account.

    Raises ValueError if the username already exists.
    """
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM users WHERE username=%s", (username,))
    if cur.fetchone():
        cur.close()
        conn.close()
        raise ValueError("User already exists")
    cur.execute(
        "INSERT INTO users (username, password) VALUES (%s, %s)",
        (username, pwd_context.hash(password)),
    )
    conn.commit()
    cur.close()
    conn.close()


def admin_exists() -> bool:
    """Return True if the admin account already exists."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM users WHERE username=%s", ("admin",))
    exists = cur.fetchone() is not None
    cur.close()
    conn.close()
    return exists


def get_user_system_prompt(username: str) -> str:
    """Get the system prompt for a specific user."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT system_prompt FROM users WHERE username=%s", (username,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    return row[0] if row else ""


def update_user_system_prompt(username: str, system_prompt: str) -> None:
    """Update the system prompt for a specific user."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "UPDATE users SET system_prompt=%s WHERE username=%s",
        (system_prompt, username)
    )
    conn.commit()
    cur.close()
    conn.close()


def upsert_streaming_message(username: str, message: dict, conversation_id: int) -> None:
    """Upsert a streaming message - update existing partial message or create new one."""
    conn = get_connection()
    cur = conn.cursor()
    
    message_hash = message.get("message_hash")
    if not message_hash:
        raise ValueError("Message hash is required for streaming messages")
    
    role = message.get("role")
    content = message.get("content", "")
    created_at = message.get("created_at")
    updated_at = message.get("updated_at", created_at)
    
    # Check if message already exists
    cur.execute(
        "SELECT id FROM messages WHERE message_hash=%s AND username=%s AND conversation_id=%s",
        (message_hash, username, conversation_id)
    )
    existing = cur.fetchone()
    
    if existing:
        # Update existing message
        cur.execute(
            "UPDATE messages SET message=%s, updated_at=%s WHERE message_hash=%s AND username=%s AND conversation_id=%s",
            (content, updated_at, message_hash, username, conversation_id)
        )
    else:
        # Insert new message
        cur.execute(
            "INSERT INTO messages (role, username, message, conversation_id, message_hash, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (role, username, content, conversation_id, message_hash, created_at, updated_at)
        )
    
    # Update conversation's updated_at timestamp
    cur.execute(
        "UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=%s",
        (conversation_id,)
    )
    
    conn.commit()
    cur.close()
    conn.close()

def fetch_message_by_id(username: str, message_id: int):
    """Fetch a specific message by its ID.
    
    Parameters
    ----------
    username : str
        The username of the message owner
    message_id : int
        The ID of the message to fetch
    
    Returns
    -------
    dict or None
        Message data if found, None if not found or access denied
    """
    conn = get_connection()
    cur = conn.cursor()
    
    # Fetch the message and verify ownership
    cur.execute(
        "SELECT id, role, message, conversation_id, message_hash, created_at, updated_at FROM messages WHERE id=%s AND username=%s",
        (message_id, username)
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    
    if not row:
        return None
    
    return {
        "id": row[0],
        "role": row[1],
        "content": row[2],
        "conversation_id": row[3],
        "message_hash": row[4],
        "created_at": row[5].isoformat(),
        "updated_at": row[6].isoformat() if row[6] else row[5].isoformat(),
    }
