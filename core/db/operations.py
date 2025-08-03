import os
import psycopg2
from passlib.context import CryptContext
from alembic.config import Config
from alembic import command

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://kurisu:kurisu@localhost:5432/kurisu")


def authenticate_user(username: str, password: str) -> bool:
    """Authenticate a user with username and password."""
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT password FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        
        if not row:
            return False
        return pwd_context.verify(password, row[0])
    except Exception:
        return False


def get_connection():
    return psycopg2.connect(DATABASE_URL)


def get_db_connection():
    """Alias for get_connection() for consistency with Agent class expectations."""
    return get_connection()




def init_db():
    """Initialize database using Alembic migrations."""
    try:
        # Run Alembic migrations to create/update schema
        alembic_cfg = Config(os.path.join(os.path.dirname(os.path.dirname(__file__)), "alembic.ini"))
        command.upgrade(alembic_cfg, "head")
        
        # Ensure default admin account exists
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO users (username, password) VALUES (%s, %s) ON CONFLICT (username) DO NOTHING",
            ("admin", pwd_context.hash("admin")),
        )
        conn.commit()
        cur.close()
        conn.close()
        
        print("Database initialized successfully using Alembic migrations")
    except Exception as e:
        print(f"Error initializing database: {e}")
        # Fallback to manual table creation if needed
        _init_db_manual()


def _init_db_manual():
    """Fallback manual database initialization."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            system_prompt TEXT DEFAULT '',
            preferred_name TEXT DEFAULT ''
        )
        """
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
    
    # ensure default admin account
    cur.execute(
        "INSERT INTO users (username, password) VALUES (%s, %s) ON CONFLICT (username) DO NOTHING",
        ("admin", pwd_context.hash("admin")),
    )
    conn.commit()
    cur.close()
    conn.close()
    print("Database initialized using manual schema creation")


def add_messages(
    username: str,
    messages: list,
    conversation_id: int | None = None,
) -> tuple[int, list[int]]:
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
    tuple[int, list[int]]
        A tuple containing (conversation_id, list_of_message_ids).
        
    Raises
    ------
    ValueError
        If no conversation exists for the user.
    """
    if not messages:
        return conversation_id or 0, []
        
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
    message_ids = []
    
    # Insert all new messages into the messages table
    for msg in messages:
        created_at = msg.get("created_at")
        updated_at = msg.get("updated_at")
        
        cur.execute(
            "INSERT INTO messages (role, username, message, conversation_id, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (msg["role"], username, msg["content"], conv_id, created_at, updated_at)
        )
        message_id = cur.fetchone()[0]
        message_ids.append(message_id)
    
    # Update conversation's updated_at timestamp
    cur.execute(
        "UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=%s",
        (conv_id,)
    )
    conn.commit()
    cur.close()
    conn.close()
    return conv_id, message_ids


def upsert_streaming_message(username: str, message: dict, conversation_id: int) -> int:
    """Upsert a streaming message - create new message or update existing one based on role sequence.
    
    If the last message in the conversation has the same role, concatenate content.
    Otherwise, create a new message.
    
    Returns the message ID of the created or updated message.
    """
    conn = get_connection()
    cur = conn.cursor()
    
    role = message.get("role")
    content = message.get("content", "")
    created_at = message.get("created_at")
    updated_at = message.get("updated_at", created_at)
    
    # Get the last message for this conversation to check if we should append or create new
    cur.execute(
        "SELECT id, role, message FROM messages WHERE username=%s AND conversation_id=%s ORDER BY created_at DESC, id DESC LIMIT 1",
        (username, conversation_id)
    )
    last_message = cur.fetchone()
    
    message_id = None
    
    if last_message and last_message[1] == role:
        # Same role as last message - concatenate content
        last_id, last_role, last_content = last_message
        new_content = last_content + content
        
        cur.execute(
            "UPDATE messages SET message=%s, updated_at=%s WHERE id=%s",
            (new_content, updated_at, last_id)
        )
        message_id = last_id
    else:
        # Different role or no previous message - create new message
        cur.execute(
            "INSERT INTO messages (role, username, message, conversation_id, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (role, username, content, conversation_id, created_at, updated_at)
        )
        message_id = cur.fetchone()[0]
    
    # Update conversation's updated_at timestamp
    cur.execute(
        "UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=%s",
        (conversation_id,)
    )
    
    conn.commit()
    cur.close()
    conn.close()
    return message_id




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
        "SELECT id, role, message, created_at, updated_at FROM messages WHERE username=%s AND conversation_id=%s ORDER BY created_at ASC LIMIT %s OFFSET %s",
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
            "updated_at": msg_row[4].isoformat() if msg_row[4] else msg_row[3].isoformat(),
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
        # Calculate latest_offset: aligned to page boundaries (20 messages per page)
        # This ensures the last page starts at a multiple of 20 and contains the most recent messages
        latest_offset = ((message_count - 1) // 20) * 20 if message_count > 0 else 0
        
        conversations.append({
            "id": r[0],
            "title": r[1] or "New conversation",
            "created_at": r[2].isoformat(),
            "updated_at": r[3].isoformat() if r[3] else r[2].isoformat(),
            "message_count": message_count,
            "max_offset": latest_offset,
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


def get_user_preferred_name(username: str) -> str:
    """Get the preferred name for a specific user."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT preferred_name FROM users WHERE username=%s", (username,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    return row[0] if row else ""


def update_user_preferred_name(username: str, preferred_name: str) -> None:
    """Update the preferred name for a specific user."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "UPDATE users SET preferred_name=%s WHERE username=%s",
        (preferred_name, username)
    )
    conn.commit()
    cur.close()
    conn.close()


def get_user_preferences(username: str) -> tuple[str, str]:
    """Get both system prompt and preferred name for a specific user in a single query.
    
    Returns:
        tuple: (system_prompt, preferred_name)
    """
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT system_prompt, preferred_name FROM users WHERE username=%s", (username,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row:
        return row[0] if row[0] else "", row[1] if row[1] else ""
    else:
        return "", ""


def update_user_preferences(username: str, system_prompt: str = None, preferred_name: str = None) -> None:
    """Update system prompt and/or preferred name for a specific user.
    
    Args:
        username: The username to update
        system_prompt: New system prompt (optional, if None, won't be updated)
        preferred_name: New preferred name (optional, if None, won't be updated)
    """
    if system_prompt is None and preferred_name is None:
        return
    
    conn = get_connection()
    cur = conn.cursor()
    
    updates = []
    params = []
    
    if system_prompt is not None:
        updates.append("system_prompt=%s")
        params.append(system_prompt)
    
    if preferred_name is not None:
        updates.append("preferred_name=%s")
        params.append(preferred_name)
    
    params.append(username)
    
    query = f"UPDATE users SET {', '.join(updates)} WHERE username=%s"
    cur.execute(query, params)
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
        "SELECT id, role, message, conversation_id, created_at, updated_at FROM messages WHERE id=%s AND username=%s",
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
        "created_at": row[4].isoformat(),
        "updated_at": row[5].isoformat() if row[5] else row[4].isoformat(),
    }
