"""Google Gemini LLM provider implementation.

Uses the google-genai SDK. Normalizes Gemini responses to match Ollama's
streaming chunk format so agents work unchanged.
"""

import json
import logging
import os
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any

from google import genai
from google.genai import types

from .base import BaseLLMProvider

logger = logging.getLogger(__name__)


# --- Response wrappers to match Ollama's chunk format ---

@dataclass
class ToolCallFunction:
    name: str
    arguments: dict


@dataclass
class ToolCall:
    function: ToolCallFunction


@dataclass
class OllamaStyleMessage:
    content: str = ""
    thinking: Optional[str] = None
    tool_calls: Optional[List[ToolCall]] = None


@dataclass
class OllamaStyleChunk:
    message: OllamaStyleMessage = field(default_factory=OllamaStyleMessage)


# --- Message conversion ---

def _convert_messages(messages: List[Dict]) -> tuple[Optional[str], list[types.Content]]:
    """Convert Ollama-format messages to Gemini format.

    Returns (system_instruction, contents).
    """
    system_parts = []
    contents = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            system_parts.append(content)
            continue

        # Map roles: Ollama uses "assistant", Gemini uses "model"
        gemini_role = "model" if role == "assistant" else "user"

        # Tool result messages → map to "user" with function response
        if role == "tool":
            # Gemini expects function responses as user messages
            tool_name = msg.get("name", "tool")
            contents.append(types.Content(
                role="user",
                parts=[types.Part.from_function_response(
                    name=tool_name,
                    response={"result": content},
                )],
            ))
            continue

        # Handle tool_calls in assistant messages
        if role == "assistant" and msg.get("tool_calls"):
            parts = []
            if content:
                parts.append(types.Part.from_text(text=content))
            for tc in msg["tool_calls"]:
                fn = tc.get("function", {})
                args = fn.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except (json.JSONDecodeError, TypeError):
                        args = {}
                parts.append(types.Part.from_function_call(
                    name=fn.get("name", ""),
                    args=args,
                ))
            contents.append(types.Content(role="model", parts=parts))
            continue

        # Regular message
        if content:
            contents.append(types.Content(
                role=gemini_role,
                parts=[types.Part.from_text(text=content)],
            ))

    system_instruction = "\n\n".join(system_parts) if system_parts else None
    return system_instruction, contents


def _convert_tools(tools: List[Dict]) -> Optional[list[types.Tool]]:
    """Convert Ollama-format tool schemas to Gemini FunctionDeclarations."""
    if not tools:
        return None

    declarations = []
    for tool in tools:
        fn = tool.get("function", {})
        name = fn.get("name", "")
        description = fn.get("description", "")
        params = fn.get("parameters", {})

        # Clean up parameters for Gemini (remove unsupported fields)
        schema = _clean_schema(params) if params else None

        declarations.append(types.FunctionDeclaration(
            name=name,
            description=description,
            parameters=schema,
        ))

    return [types.Tool(function_declarations=declarations)]


def _clean_schema(schema: dict) -> dict:
    """Clean a JSON Schema for Gemini compatibility."""
    cleaned = {}
    if "type" in schema:
        cleaned["type"] = schema["type"].upper() if isinstance(schema["type"], str) else schema["type"]
    if "description" in schema:
        cleaned["description"] = schema["description"]
    if "properties" in schema:
        cleaned["properties"] = {
            k: _clean_schema(v) for k, v in schema["properties"].items()
        }
    if "required" in schema and schema["required"]:
        cleaned["required"] = schema["required"]
    if "items" in schema:
        cleaned["items"] = _clean_schema(schema["items"])
    if "enum" in schema:
        cleaned["enum"] = schema["enum"]
    return cleaned


class GeminiProvider(BaseLLMProvider):
    """Google Gemini implementation of BaseLLMProvider."""

    def __init__(self, api_key: Optional[str] = None):
        if api_key is None:
            api_key = os.getenv("GEMINI_API_KEY", "")

        if not api_key:
            logger.warning("No Gemini API key provided")

        self.client = genai.Client(api_key=api_key)
        logger.info("Initialized Gemini provider")

    def chat(
        self,
        model: str,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        stream: bool = True,
        **kwargs,
    ):
        """Send a chat request to Gemini, yielding Ollama-compatible chunks."""
        think = kwargs.get("think", False)
        options = kwargs.get("options", {})

        system_instruction, contents = _convert_messages(messages)
        gemini_tools = _convert_tools(tools) if tools else None

        # Build config
        config_kwargs: Dict[str, Any] = {}
        if options.get("temperature") is not None:
            config_kwargs["temperature"] = options["temperature"]
        if options.get("num_ctx"):
            config_kwargs["max_output_tokens"] = min(options["num_ctx"], 65536)

        # Thinking support
        if think:
            config_kwargs["thinking_config"] = types.ThinkingConfig(
                thinking_budget=16000,
            )

        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            tools=gemini_tools,
            **config_kwargs,
        )

        try:
            if stream:
                return self._stream_chat(model, contents, config)
            else:
                return self._sync_chat(model, contents, config)
        except Exception as e:
            logger.error(f"Gemini chat failed (model={model}): {e}", exc_info=True)
            raise

    def _stream_chat(self, model: str, contents, config):
        """Stream chat responses, yielding OllamaStyleChunks."""
        response = self.client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config,
        )

        for chunk in response:
            # Check for function calls
            if chunk.candidates and chunk.candidates[0].content and chunk.candidates[0].content.parts:
                parts = chunk.candidates[0].content.parts
                tool_calls = []
                text_content = ""
                thinking_content = None

                for part in parts:
                    if part.function_call:
                        fc = part.function_call
                        tool_calls.append(ToolCall(
                            function=ToolCallFunction(
                                name=fc.name,
                                arguments=dict(fc.args) if fc.args else {},
                            )
                        ))
                    elif part.thought:
                        thinking_content = (thinking_content or "") + part.text
                    elif part.text:
                        text_content += part.text

                yield OllamaStyleChunk(
                    message=OllamaStyleMessage(
                        content=text_content,
                        thinking=thinking_content,
                        tool_calls=tool_calls if tool_calls else None,
                    )
                )

    def _sync_chat(self, model: str, contents, config):
        """Non-streaming chat, returns a single OllamaStyleChunk."""
        response = self.client.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )

        text = response.text or ""
        tool_calls = []

        if response.candidates and response.candidates[0].content:
            for part in response.candidates[0].content.parts:
                if part.function_call:
                    fc = part.function_call
                    tool_calls.append(ToolCall(
                        function=ToolCallFunction(
                            name=fc.name,
                            arguments=dict(fc.args) if fc.args else {},
                        )
                    ))

        return OllamaStyleChunk(
            message=OllamaStyleMessage(
                content=text,
                tool_calls=tool_calls if tool_calls else None,
            )
        )

    def list_models(self) -> List[str]:
        """List available Gemini models."""
        try:
            models = []
            for model in self.client.models.list():
                name = model.name
                # Strip "models/" prefix
                if name.startswith("models/"):
                    name = name[7:]
                models.append(name)
            return models
        except Exception as e:
            logger.error(f"Failed to list Gemini models: {e}", exc_info=True)
            return [
                "gemini-2.5-flash-preview-05-20",
                "gemini-2.5-pro-preview-05-06",
                "gemini-2.0-flash",
                "gemini-2.0-flash-lite",
            ]

    def generate(
        self,
        model: str,
        prompt: str,
        options: Optional[Dict] = None,
        stream: bool = False,
    ) -> str:
        """Generate text using Gemini."""
        try:
            response = self.client.models.generate_content(
                model=model,
                contents=prompt,
            )
            return response.text or ""
        except Exception as e:
            logger.error(f"Gemini generate failed (model={model}): {e}", exc_info=True)
            raise

    def ensure_model_available(self, model: str) -> bool:
        """No-op for cloud API — models are always available."""
        return False

    def pull_model(self, model: str) -> None:
        """No-op for cloud API."""
        pass
