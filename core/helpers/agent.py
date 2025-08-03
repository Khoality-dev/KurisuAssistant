import json
import os
import time
import datetime
from ollama import Client as OllamaClient
from mcp_tools.client import list_tools, call_tool
from .db import get_user_system_prompt, get_user_preferred_name, upsert_streaming_message

SYSTEM_PROMPT = """
You have access to conversation context tools that allow you to retrieve and search through the current conversation's message history. These tools are automatically scoped to the current conversation.

## Available Context Tools:

### retrieve_messages_by_date_range
Retrieve messages from the current conversation within a specific date range.
- Use when users ask about "what we discussed yesterday", "messages from last week", or any time-based queries
- Parameters: start_date, end_date (ISO format like "2024-01-15" or "2024-01-15T10:30:00"), optional limit
- Example uses: "What did we talk about yesterday?", "Show me our conversation from last Monday"

### retrieve_messages_by_regex
Search for messages in the current conversation using regular expressions.
- Use when users want to find specific content, keywords, or patterns in the conversation
- Parameters: pattern (regex), optional case_sensitive (default false), optional limit
- Example uses: "Did I mention my email address?", "Find where we talked about Python", "Search for any numbers I shared"
- Common patterns: ".*email.*" (find emails), "\\d+" (find numbers), "python|code|programming" (find tech terms)

### get_conversation_summary
Get metadata and statistics about the current conversation.
- Use when users ask about conversation length, when it started, message counts, etc.
- No additional parameters needed
- Example uses: "How long have we been talking?", "When did this conversation start?", "How many messages have we exchanged?"

## When to Use These Tools:

1. **User References Past Messages**: Any time the user mentions something from earlier in the conversation
2. **Memory Queries**: When users ask "Did I tell you about...", "What did I say about...", "Do you remember when..."
3. **Search Requests**: When users want to find specific information they shared previously
4. **Conversation Analytics**: When users ask about the conversation itself (length, timing, etc.)

## Important Notes:
- These tools work automatically on the current conversation - you don't need to specify conversation IDs
- Use date ranges thoughtfully - consider the conversation's actual timeline
- For regex searches, start simple (like ".*keyword.*") and be case-insensitive by default
- Always explain what you're searching for when using these tools

Be proactive in offering to search conversation history when it would be helpful!
"""


class Agent:
    def __init__(self, username, conversation_id, mcp_client):
        self.api_url = os.getenv("LLM_API_URL", "http://10.0.0.122:11434")
        print(f"LLM API URL: {self.api_url}")
        self.delimiters = [".", "\n", "?", ":", "!", ";"]
        self.ollama_client = OllamaClient(host=self.api_url)
        self.mcp_client = mcp_client
        self.cached_tools = []
        self.tools_cache_time = 0
        self.context_messages = []

        self.username = username
        self.conversation_id = conversation_id

        # fetch system prompts from db
        self.system_prompt = get_user_system_prompt(self.username)

    def list_models(self):
        """Return a list of available model names."""
        try:
            resp = self.ollama_client.list()
            return [m.model for m in getattr(resp, "models", [])]
        except Exception:
            return []

    def generate(self, payload, user_system_prompts=None):
        """Generate text using Ollama's generate API with similar interface to chat.

        Unlike chat, this doesn't maintain conversation history and is suitable
        for one-off text generation tasks like title generation.
        """
        # Use user-specific system prompts if provided
        system_prompts = user_system_prompts if user_system_prompts is not None else []

        # Build the prompt from system prompts and user message
        full_prompt = ""
        for prompt in system_prompts:
            if prompt.get("role") == "system":
                full_prompt += prompt.get("content", "") + "\n\n"

        # Add the user message
        user_message = payload.get("message", {}).get("content", "")
        full_prompt += user_message

        # Extract generation options from payload
        model = payload.get("model", "llama3.2:3b")
        options = payload.get("options", {})

        default_options = {
            "temperature": 0.7,
        }
        default_options.update(options)

        response = self.ollama_client.generate(
            model=model,
            prompt=full_prompt.strip(),
            stream=False,
            options=default_options,
        )

        return response.response.strip()

    async def get_tools(self):
        """Get MCP tools with caching to avoid repeated connections."""
        current_time = time.time()
        # Cache tools for 30 seconds to reduce MCP client connection overhead
        if current_time - self.tools_cache_time > 30:
            if self.mcp_client is not None:
                try:
                    self.cached_tools = await list_tools(self.mcp_client)
                    self.tools_cache_time = current_time
                except Exception as e:
                    print(f"Error getting MCP tools: {e}")
                    self.cached_tools = []
            else:
                self.cached_tools = []
        return self.cached_tools

    def pull_model(self, model_name):
        self.ollama_client.pull(model_name)

    async def chat(self, model_name, user_message):
        """Send a chat request and yield streaming responses."""
        created_at = datetime.datetime.utcnow().isoformat()
        user_msg = {
            "role": "user",
            "content": user_message,
            "created_at": created_at,
            "updated_at": created_at,
        }
        
        # Immediately save user message to database to get message_id
        message_id = upsert_streaming_message(self.username, user_msg, self.conversation_id)
        user_msg["message_id"] = message_id
        yield user_msg
        self.context_messages.append(user_msg)
        buffer = ""
        while True:
            buffer = ""
            # Get tools with caching to avoid repeated MCP connections
            tools = await self.get_tools()
            # Get user's preferred name and build system message
            user_preferred_name = get_user_preferred_name(self.username)
            preferred_name_text = f"\n\nThe user prefers to be called: {user_preferred_name}" if user_preferred_name else ""
            
            # Use the recent messages directly
            messages = [
                {
                    "role": "system",
                    "content": SYSTEM_PROMPT
                    + f"\n\nCurrent time is {datetime.datetime.utcnow().isoformat()}"
                    + preferred_name_text,
                },
                {"role": "system", "content": self.system_prompt},
                *self.context_messages,
            ]
            stream = self.ollama_client.chat(
                model=model_name,
                messages=messages,
                stream=True,
                tools=tools,
            )

            made_tool_call = False
            for chunk in stream:
                msg = chunk.message

                buffer += msg.content
                print(chunk)
                if msg.tool_calls:
                    created_at = datetime.datetime.utcnow().isoformat()
                    assistant_msg = {"role": "assistant", "content": msg.content, "tool_calls": msg.tool_calls, "created_at": created_at, "updated_at": created_at}
                    # Save assistant message with tool calls to database first to get message_id
                    message_id = upsert_streaming_message(self.username, assistant_msg, self.conversation_id)
                    assistant_msg["message_id"] = message_id
                    self.context_messages.append(assistant_msg)
                    for tool_call in msg.tool_calls:
                        if self.mcp_client is not None:
                            result = await call_tool(
                                self.mcp_client,
                                tool_call.function.name,
                                tool_call.function.arguments,
                                conversation_id=self.conversation_id,
                            )
                            tool_text = result[0].text
                        else:
                            tool_text = "MCP client not available"
                        created_at = datetime.datetime.utcnow().isoformat()
                        tool_message = {
                            "role": "tool",
                            "content": tool_text,
                            "tool_name": tool_call.function.name,
                            "created_at": created_at,
                            "updated_at": created_at,
                        }
                        # Save to database first to get message_id
                        message_id = upsert_streaming_message(self.username, tool_message, self.conversation_id)
                        tool_message["message_id"] = message_id
                        yield tool_message
                        # Add tool response to recent_messages
                        self.context_messages.append(tool_message)
                    made_tool_call = True

                # Find the last occurrence of any delimiter in the buffer
                last_delimiter_pos = -1
                for delimiter in self.delimiters:
                    pos = buffer.rfind(delimiter)
                    if pos > last_delimiter_pos:
                        last_delimiter_pos = pos

                # If we found a delimiter, check if we have a complete sentence with minimum words
                if last_delimiter_pos >= 0:
                    # Extract the complete sentence(s) up to and including the delimiter
                    complete_sentence = buffer[: last_delimiter_pos + 1]
                    word_count = len(complete_sentence.split())

                    # Yield if we have at least 10 words
                    if word_count >= 10:
                        created_at = datetime.datetime.utcnow().isoformat()
                        message = {
                            "role": "assistant",
                            "content": complete_sentence,
                            "created_at": created_at,
                            "updated_at": created_at,
                        }
                        # Save/update message in database first to get message_id
                        message_id = upsert_streaming_message(self.username, message, self.conversation_id)
                        message["message_id"] = message_id
                        yield message
                        if self.context_messages[-1]["role"] == message["role"]:
                            self.context_messages[-1]["content"] += message["content"]
                            self.context_messages[-1]["updated_at"] = message["updated_at"]
                            self.context_messages[-1]["message_id"] = message_id
                        else:
                            self.context_messages.append(message)
                        # Keep the remaining part in buffer
                        buffer = buffer[last_delimiter_pos + 1 :]

            if not made_tool_call:
                break
        
        rstrip_buffer = buffer.rstrip()
        if rstrip_buffer != "":
            # If there's any remaining buffer, yield it as the final message
            created_at = datetime.datetime.utcnow().isoformat()
            message = {
                "role": "assistant",
                "content": rstrip_buffer,
                "created_at": created_at,
                "updated_at": created_at,
            }
            # Save final message to database first to get message_id
            message_id = upsert_streaming_message(self.username, message, self.conversation_id)
            message["message_id"] = message_id
            yield message
            self.context_messages.append(message)
