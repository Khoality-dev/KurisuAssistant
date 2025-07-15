import json
import os
from ollama import Client
from mcp_tools.client import list_tools, call_tool


class LLM:
    def __init__(self, mcp_client):
        self.api_url = os.getenv("LLM_API_URL", "http://10.0.0.122:11434")
        print(f"LLM API URL: {self.api_url}")
        self.delimiters = ['.', '\n', '?']
        self.client = Client(host=self.api_url)
        # Default system prompt is empty - user-specific prompts are handled per-request
        self.system_prompts = []
        self.mcp_client = mcp_client
        self.history = []

    def list_models(self):
        """Return a list of available model names."""
        try:
            resp = self.client.list()
            return [m.model for m in getattr(resp, "models", [])]
        except Exception:
            return []
        
    def pull_model(self, model_name):
        self.client.pull(model_name)

    async def __call__(self, payload, user_system_prompts=None):
        """Send a chat request and yield streaming responses.

        The entire conversation, including intermediate tool calls and assistant
        replies, is stored in ``self.history``.
        """

        self.history.append({**payload["message"], "model": None})

        accumulated = ""
        buffer = ""

        while True:
            # Get tools from MCP client if available, otherwise use empty list
            tools = await list_tools(self.mcp_client) if self.mcp_client is not None else []
            # Use user-specific system prompts if provided, otherwise use default
            system_prompts = user_system_prompts if user_system_prompts is not None else self.system_prompts
            messages = system_prompts + self.history
            stream = self.client.chat(
                model=payload["model"],
                messages=messages,
                stream=payload["stream"],
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
                    self.history.append(
                        {
                            "role": "assistant",
                            "content": accumulated,
                            "model": payload.get("model"),
                            "tool_calls": [tc.dict() for tc in msg.tool_calls],
                        }
                    )
                    print(self.history[-1])
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
                        self.history.append(
                            {
                                "role": "tool",
                                "content": tool_text,
                                "model": None,
                            }
                        )
                        yield {
                            "message": {"role": "tool", "content": tool_text},
                            "done": True,
                        }
                        print(self.history[-1])
                    made_tool_call = True
                    break

                if len(buffer) > 20 or data.get("done"):
                    data["message"]["content"] = buffer
                    yield data
                    buffer = ""
                if data.get("done"):
                    self.history.append(
                        {"role": "assistant", "content": accumulated, "model": payload.get("model")}
                    )
                    print(self.history[-1])
                    return

            if not made_tool_call:
                break
            accumulated = ""
            buffer = ""

