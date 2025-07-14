import os
import psycopg2
import json
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://kurisu:kurisu@localhost:5432/kurisu")


def get_connection():
    return psycopg2.connect(DATABASE_URL)


def init_db():
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL
        )
        """
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
            messages JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()
    cur.close()
    conn.close()


def add_message(
    username: str,
    role: str,
    content: str,
    model: str | None = None,
    system_prompts=None,
) -> None:
    """Append a message to the user's latest conversation.

    If the user has no conversation yet, a new one is started and the provided
    system prompts are included in the message history.
    """
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, messages FROM conversations WHERE username=%s ORDER BY id DESC LIMIT 1",
        (username,),
    )
    row = cur.fetchone()
    if row:
        conv_id, messages = row
        messages["messages"].append({"role": role, "content": content, "model": model})
        cur.execute(
            "UPDATE conversations SET messages=%s WHERE id=%s",
            (json.dumps(messages), conv_id),
        )
    else:
        if system_prompts is None:
            system_prompts = []
        formatted_prompts = [
            {**p, "model": None} if "model" not in p else p for p in system_prompts
        ]
        new_messages = {
            "messages": formatted_prompts
            + [{"role": role, "content": content, "model": model}]
        }
        cur.execute(
            "INSERT INTO conversations (username, messages) VALUES (%s, %s)",
            (username, json.dumps(new_messages)),
        )
    conn.commit()
    cur.close()
    conn.close()


def get_history(username: str, limit: int = 50):
    """Return the most recent conversations for a user."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT messages, created_at FROM conversations WHERE username=%s ORDER BY id DESC LIMIT %s",
        (username, limit),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [
        {"messages": r[0]["messages"], "created_at": r[1].isoformat()} for r in rows
    ]


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
