import json
import os
import time
import datetime
from ollama import Client as OllamaClient
from mcp_tools.client import list_tools, call_tool
from .db import get_user_system_prompt, generate_message_hash

class Agent:
    def __init__(self, username, conversation_id, mcp_client):
        self.api_url = os.getenv("LLM_API_URL", "http://10.0.0.122:11434")
        print(f"LLM API URL: {self.api_url}")
        self.delimiters = ['.', '\n', '?', ':', '!', ';']
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
            options=default_options
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
    
    def merge_contexts(self):
        """Merge multiple contexts into a single context."""
        merged_message = None
        new_context_messages = []
        for message in self.context_messages:
            if merged_message is not None and merged_message["role"] == message["role"]:
                merged_message['content'] = merged_message["content"] + " " + message["content"]
                # Keep the created_at from the first message, but update updated_at to the last message's created_at
                merged_message['updated_at'] = message.get("created_at", merged_message.get("created_at"))
            else:
                if merged_message is not None:
                    merged_message['content'] = merged_message["content"].strip()
                    new_context_messages.append(merged_message)    
                merged_message = message.copy()
                # Initialize updated_at to created_at for new merged message
                merged_message['updated_at'] = merged_message.get("created_at")

        if merged_message is not None:
            merged_message['content'] = merged_message["content"].strip()
            new_context_messages.append(merged_message)
        self.context_messages = new_context_messages
        return new_context_messages

    async def chat(self, model_name, user_message):
        """Send a chat request and yield streaming responses.
        """
        created_at = datetime.datetime.utcnow().isoformat()
        message_hash = generate_message_hash("user", user_message, self.username, self.conversation_id, created_at)
        self.context_messages.append({
            "role": "user",
            "content": user_message,
            "created_at": created_at,
            "updated_at": created_at,
            "message_hash": message_hash
        })

        buffer = ""
        while True:
            buffer = ""
            # Get tools with caching to avoid repeated MCP connections
            tools = await self.get_tools()
            # Use the recent messages directly
            self.merge_contexts()
            messages = [{"role":"system", "content": self.system_prompt}, *self.context_messages]
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
                    self.context_messages.append(msg.message)
                    for tool_call in msg.tool_calls:
                        if self.mcp_client is not None:
                            result = await call_tool(
                                self.mcp_client,
                                tool_call.function.name,
                                tool_call.function.arguments,
                            )
                            tool_text = result[0].text
                        else:
                            tool_text = "MCP client not available"
                        created_at = datetime.datetime.utcnow().isoformat()
                        message_hash = generate_message_hash("tool", tool_text, self.username, self.conversation_id, created_at)
                        tool_message = {
                            "role": "tool",
                            "content": tool_text,
                            "tool_name": tool_call.function.name,
                            "created_at": created_at,
                            "updated_at": created_at,
                            "message_hash": message_hash
                        }
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
                    complete_sentence = buffer[:last_delimiter_pos + 1]
                    word_count = len(complete_sentence.split())
                    
                    # Yield if we have at least 10 words
                    if word_count >= 10:
                        created_at = datetime.datetime.utcnow().isoformat()
                        message_hash = generate_message_hash("assistant", complete_sentence, self.username, self.conversation_id, created_at)
                        message = {
                            "role": "assistant",
                            "content": complete_sentence,
                            "created_at": created_at,
                            "updated_at": created_at,
                            "message_hash": message_hash
                        }
                        yield message
                        self.context_messages.append(message)
                        # Keep the remaining part in buffer
                        buffer = buffer[last_delimiter_pos + 1:]

            if not made_tool_call:
                break

        if buffer != "":
            # If there's any remaining buffer, yield it as the final message
            created_at = datetime.datetime.utcnow().isoformat()
            message_hash = generate_message_hash("assistant", buffer.strip(), self.username, self.conversation_id, created_at)
            message = {
                "role": "assistant",
                "content": buffer.strip(),
                "created_at": created_at,
                "updated_at": created_at,
                "message_hash": message_hash
            }
            yield message
            self.context_messages.append(message)

