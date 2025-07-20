import sys
import os
import re
from datetime import datetime
from fastmcp import FastMCP
from typing import Annotated, List, Optional
from pydantic import Field

# Import local database functions
from db import (
    retrieve_messages_by_date_range_db,
    retrieve_all_messages_for_regex_db,
    get_conversation_summary_db,
    test_connection
)

mcp = FastMCP(
    "Context Service",
    instructions="This server provides functions to retrieve and search conversation context from the database."
)

@mcp.tool()
def retrieve_messages_by_date_range(
    start_date: Annotated[
        str,
        Field(description="Start date in ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)")
    ],
    end_date: Annotated[
        str,
        Field(description="End date in ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)")
    ],
    limit: Annotated[
        Optional[int],
        Field(description="Optional: Maximum number of messages to return (default: 100)", default=100)
    ],
    conversation_id: Annotated[
        Optional[int],
        Field(description="Optional: Conversation ID (automatically provided by Agent)", default=None)
    ]
) -> str:
    """Retrieve messages within a specific date range for the current conversation."""
    try:
        if conversation_id is None:
            return "Error: No conversation ID provided. This tool requires an active conversation context."
        
        # Parse dates
        try:
            start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00'))
            end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00'))
        except ValueError as e:
            return f"Error parsing dates: {e}. Use ISO format like '2024-01-01' or '2024-01-01T10:30:00'"
        
        messages = retrieve_messages_by_date_range_db(conversation_id, start_dt, end_dt, limit)
        
        if not messages:
            return f"No messages found in conversation {conversation_id} between {start_date} and {end_date}"
        
        result_summary = f"Found {len(messages)} messages in conversation {conversation_id} between {start_date} and {end_date}"
        
        return f"{result_summary}:\n\n" + "\n".join([
            f"({msg['created_at']}) {msg['role']}: {msg['content']}"
            for msg in messages
        ])
        
    except Exception as e:
        return f"Error retrieving messages by date range: {str(e)}"

@mcp.tool()
def retrieve_messages_by_regex(
    pattern: Annotated[
        str,
        Field(description="Regular expression pattern to search for in message content")
    ],
    case_sensitive: Annotated[
        Optional[bool],
        Field(description="Optional: Whether the search should be case sensitive (default: False)", default=False)
    ],
    limit: Annotated[
        Optional[int],
        Field(description="Optional: Maximum number of messages to return (default: 50)", default=50)
    ],
    conversation_id: Annotated[
        Optional[int],
        Field(description="Optional: Conversation ID (automatically provided by Agent)", default=None)
    ]
) -> str:
    """Search for messages matching a regular expression pattern in the current conversation."""
    try:
        if conversation_id is None:
            return "Error: No conversation ID provided. This tool requires an active conversation context."
        
        # Compile regex pattern
        try:
            flags = 0 if case_sensitive else re.IGNORECASE
            compiled_pattern = re.compile(pattern, flags)
        except re.error as e:
            return f"Invalid regex pattern: {e}"
        
        all_results = retrieve_all_messages_for_regex_db(conversation_id)
        
        # Filter results using regex in Python (since PostgreSQL regex syntax might vary)
        matching_messages = []
        for row in all_results:
            role, content, created_at, conv_id, msg_hash, conv_title = row
            if compiled_pattern.search(content):
                matching_messages.append({
                    "role": role,
                    "content": content,
                    "created_at": created_at.isoformat(),
                    "conversation_id": conv_id,
                    "conversation_title": conv_title or "Untitled",
                    "message_hash": msg_hash
                })
                
                # Stop if we've reached the limit
                if len(matching_messages) >= limit:
                    break
        
        if not matching_messages:
            return f"No messages found in conversation {conversation_id} matching pattern '{pattern}'"
        
        result_summary = f"Found {len(matching_messages)} messages in conversation {conversation_id} matching pattern '{pattern}'"
        
        return f"{result_summary}:\n\n" + "\n".join([
            f"[{msg['conversation_title']}] ({msg['created_at']}) {msg['role']}: {msg['content'][:150]}{'...' if len(msg['content']) > 150 else ''}"
            for msg in matching_messages
        ])
        
    except Exception as e:
        return f"Error searching messages by regex: {str(e)}"

@mcp.tool()
def get_conversation_summary(
    conversation_id: Annotated[
        Optional[int],
        Field(description="Optional: Conversation ID (automatically provided by Agent)", default=None)
    ]
) -> str:
    """Get a summary of the current conversation."""
    try:
        if conversation_id is None:
            return "Error: No conversation ID provided. This tool requires an active conversation context."
        
        conversation = get_conversation_summary_db(conversation_id)
        
        if not conversation:
            return f"No conversation found with ID {conversation_id}"
        
        return (
            f"Conversation {conversation['id']}: '{conversation['title']}'\n"
            f"Messages: {conversation['message_count']}\n"
            f"Created: {conversation['created_at']}\n"
            f"Last updated: {conversation['updated_at']}\n"
            f"First message: {conversation['first_message'] or 'N/A'}\n"
            f"Last message: {conversation['last_message'] or 'N/A'}"
        )
        
    except Exception as e:
        return f"Error getting conversation summary: {str(e)}"

# Run the server
if __name__ == "__main__":
    mcp.run()