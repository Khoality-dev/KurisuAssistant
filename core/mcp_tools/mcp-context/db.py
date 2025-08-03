import os
import psycopg2
from datetime import datetime
from typing import List, Dict, Tuple

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://kurisu:kurisu@localhost:5432/kurisu")

def get_connection():
    """Get a database connection."""
    return psycopg2.connect(DATABASE_URL)

def retrieve_messages_by_date_range_db(
    conversation_id: int,
    start_date: datetime, 
    end_date: datetime,
    limit: int = 100
) -> List[Dict]:
    """Retrieve messages from database within a specific date range."""
    conn = get_connection()
    cur = conn.cursor()
    
    try:
        query = """
            SELECT m.role, m.message, m.created_at, m.conversation_id, c.title
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE m.conversation_id = %s
            AND m.created_at BETWEEN %s AND %s
            ORDER BY m.created_at ASC
            LIMIT %s
        """
        params = (conversation_id, start_date, end_date, limit)
        
        cur.execute(query, params)
        results = cur.fetchall()
        
        messages = []
        for row in results:
            role, content, created_at, conv_id, conv_title = row
            messages.append({
                "role": role,
                "content": content,
                "created_at": created_at.isoformat(),
                "conversation_id": conv_id,
                "conversation_title": conv_title or "Untitled",
            })
        
        return messages
        
    finally:
        cur.close()
        conn.close()

def retrieve_all_messages_for_regex_db(
    conversation_id: int
) -> List[Tuple]:
    """Retrieve all messages for regex filtering."""
    conn = get_connection()
    cur = conn.cursor()
    
    try:
        query = """
            SELECT m.role, m.message, m.created_at, m.conversation_id, c.title
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE m.conversation_id = %s
            ORDER BY m.created_at DESC
        """
        params = (conversation_id,)
        
        cur.execute(query, params)
        return cur.fetchall()
        
    finally:
        cur.close()
        conn.close()

def get_conversation_summary_db(
    conversation_id: int
) -> Dict:
    """Get conversation summary from database."""
    conn = get_connection()
    cur = conn.cursor()
    
    try:
        query = """
            SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(m.id) as message_count,
                   MIN(m.created_at) as first_message, MAX(m.created_at) as last_message
            FROM conversations c
            LEFT JOIN messages m ON c.id = m.conversation_id
            WHERE c.id = %s
            GROUP BY c.id, c.title, c.created_at, c.updated_at
        """
        params = (conversation_id,)
        
        cur.execute(query, params)
        result = cur.fetchone()
        
        if not result:
            return None
            
        conv_id, title, created_at, updated_at, msg_count, first_msg, last_msg = result
        return {
            "id": conv_id,
            "title": title or "Untitled",
            "created_at": created_at.strftime('%Y-%m-%d %H:%M'),
            "updated_at": updated_at.strftime('%Y-%m-%d %H:%M'),
            "message_count": msg_count or 0,
            "first_message": first_msg.strftime('%Y-%m-%d %H:%M') if first_msg else None,
            "last_message": last_msg.strftime('%Y-%m-%d %H:%M') if last_msg else None
        }
        
    finally:
        cur.close()
        conn.close()

def test_connection() -> bool:
    """Test database connection."""
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1")
        result = cur.fetchone()
        cur.close()
        conn.close()
        return result is not None and result[0] == 1
    except Exception as e:
        print(f"Database connection test failed: {e}")
        return False