import os
import psycopg2
import json
import datetime
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://kurisu:kurisu@10.0.0.122:5432/kurisu")


def get_connection():
    return psycopg2.connect(DATABASE_URL)


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
    # Add system_prompt column to existing users table if it doesn't exist
    cur.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS system_prompt TEXT DEFAULT ''"
    )
    # ensure default admin account
    cur.execute(
        "INSERT INTO users (username, password) VALUES (%s, %s) ON CONFLICT (username) DO NOTHING",
        ("admin", pwd_context.hash("admin")),
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS conversations (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT,
            messages JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cur.execute(
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT"
    )
    cur.execute(
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    )
    conn.commit()
    cur.close()
    conn.close()


def add_message(
    username: str,
    role: str,
    content: str,
    model: str | None = None,
    tool_calls=None,
    conversation_id: int | None = None,
) -> int:
    """Append a message to an existing conversation.

    Parameters
    ----------
    conversation_id : int | None
        If provided, add message to this specific conversation.
        If None, add to the user's latest conversation.
    tool_calls : list | None
        If provided, the tool calls triggered by this assistant message.
    
    Returns
    -------
    int
        The conversation ID that the message was added to.
        
    Raises
    ------
    ValueError
        If no conversation exists for the user.
    """
    conn = get_connection()
    cur = conn.cursor()
    
    if conversation_id:
        cur.execute(
            "SELECT id, messages FROM conversations WHERE username=%s AND id=%s",
            (username, conversation_id),
        )
    else:
        cur.execute(
            "SELECT id, messages FROM conversations WHERE username=%s ORDER BY id DESC LIMIT 1",
            (username,),
        )
    
    row = cur.fetchone()
    if not row:
        cur.close()
        conn.close()
        raise ValueError(f"No conversation found for user {username}")
    
    conv_id, messages = row
    message_obj = {
        "role": role,
        "content": content,
        "model": model,
        "created_at": datetime.datetime.utcnow().isoformat(),
    }
    if tool_calls is not None:
        message_obj["tool_calls"] = tool_calls
    
    messages["messages"].append(message_obj)
    cur.execute(
        "UPDATE conversations SET messages=%s, updated_at=CURRENT_TIMESTAMP WHERE id=%s",
        (json.dumps(messages), conv_id),
    )
    conn.commit()
    cur.close()
    conn.close()
    return conv_id


def fetch_conversation(username: str, conversation_id: int):
    """Return a specific conversation for a user."""
    conn = get_connection()
    cur = conn.cursor()
    
    cur.execute(
        "SELECT id, messages, created_at, title FROM conversations WHERE username=%s AND id=%s",
        (username, conversation_id),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    
    if row:
        messages_data = row[1]  # This is the JSONB object
        # Extract the messages array from the stored structure
        messages_array = messages_data.get("messages", []) if messages_data else []
        return {
            "id": row[0],
            "messages": messages_array,
            "created_at": row[2].isoformat(),
            "title": row[3] or "",
        }
    else:
        return None


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
    """Return a list of conversations with basic info (id, title, created_at, message_count) for a user."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """SELECT id, title, created_at, updated_at,
                  CASE WHEN messages IS NULL THEN 0 ELSE jsonb_array_length(messages->'messages') END as message_count
           FROM conversations 
           WHERE username = %s 
           ORDER BY updated_at DESC 
           LIMIT %s""",
        (username, limit),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [
        {
            "id": r[0],
            "title": r[1] or "New conversation",
            "created_at": r[2].isoformat(),
            "updated_at": r[3].isoformat() if r[3] else r[2].isoformat(),
            "message_count": r[4] or 0,
        }
        for r in rows
    ]


def create_new_conversation(username: str) -> int:
    """Create a new empty conversation for the user and return its ID."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO conversations (username, title, messages) VALUES (%s, %s, %s) RETURNING id",
        (username, "New conversation", json.dumps({"messages": []})),
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
