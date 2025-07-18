import json
import os
import time
from ollama import Client
from mcp_tools.client import list_tools, call_tool


class OllamaClient:
    def __init__(self, mcp_client):
        self.api_url = os.getenv("LLM_API_URL", "http://10.0.0.122:11434")
        print(f"LLM API URL: {self.api_url}")
        self.delimiters = ['.', '\n', '?', ':', '!', ';']
        self.client = Client(host=self.api_url)
        self.mcp_client = mcp_client
        self.cached_tools = []
        self.tools_cache_time = 0

    def list_models(self):
        """Return a list of available model names."""
        try:
            resp = self.client.list()
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
        
        response = self.client.generate(
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
        self.client.pull(model_name)

    async def chat(self, model_name, messages):
        """Send a chat request and yield streaming responses.

        Uses the last 10 messages from the input for context.
        """

        # Use only the last 10 messages for context
        recent_messages = messages[-10:] if len(messages) > 10 else messages
        
        accumulated = ""
        buffer = ""

        while True:
            # Get tools with caching to avoid repeated MCP connections
            tools = await self.get_tools()
            # Use the recent messages directly
            stream = self.client.chat(
                model=model_name,
                messages=recent_messages,
                stream=True,
                tools=tools,
            )

            made_tool_call = False
            for chunk in stream:
                data = chunk.dict()
                msg = chunk.message

                accumulated += msg.content
                buffer += msg.content

                if msg.tool_calls:
                    data["message"]["content"] = accumulated
                    data["message"]["tool_calls"] = [tc.dict() for tc in msg.tool_calls]
                    yield data
                    # Add assistant message with tool calls to recent_messages
                    recent_messages.append({
                        "role": "assistant",
                        "content": accumulated,
                        "tool_calls": [tc.dict() for tc in msg.tool_calls],
                    })
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
                        # Add tool response to recent_messages
                        recent_messages.append({
                            "role": "tool",
                            "content": tool_text,
                        })
                        yield {
                            "message": {"role": "tool", "content": tool_text},
                            "done": True,
                        }
                    made_tool_call = True
                    break

                # Check for complete sentences with minimum word count
                should_yield = False
                if data.get("done"):
                    should_yield = True
                else:
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
                            data["message"]["content"] = complete_sentence
                            yield data
                            # Keep the remaining part in buffer
                            buffer = buffer[last_delimiter_pos + 1:]
                            should_yield = False  # Don't yield again below
                
                if should_yield:
                    data["message"]["content"] = buffer
                    yield data
                    buffer = ""
                if data.get("done"):
                    # Add final assistant message to recent_messages
                    recent_messages.append({
                        "role": "assistant",
                        "content": accumulated,
                    })
                    return

            if not made_tool_call:
                break
            accumulated = ""
            buffer = ""

