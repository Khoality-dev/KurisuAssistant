"""Pure LLM interface - orchestrates LLM calls with streaming and tool execution.

This module provides a clean interface for LLM interactions WITHOUT business logic:
- NO knowledge of users, conversations, chunks, or database
- Delegates to llm_providers for LLM API calls
- Handles streaming with sentence chunking
- Executes tool calls via MCP orchestrator
"""

import datetime
import logging
from typing import Optional, AsyncGenerator, Dict, List

from llm import create_llm_provider
from mcp_tools.orchestrator import get_orchestrator

logger = logging.getLogger(__name__)


# Module-level provider instance (initialized once)
_llm_provider = create_llm_provider("ollama")


def chat(
    model_name: str,
    messages: List[Dict],
    tools: Optional[List[Dict]] = None,
    images: Optional[List] = None,
):
    """Get LLM chat stream with sentence chunking.

    This function is a PURE LLM INTERFACE - it knows nothing about users, conversations,
    chunks, or database. All business logic (context loading, prompt building, user
    preferences) must be handled by the caller (main.py).

    Args:
        model_name: LLM model to use
        messages: Full conversation history (system + context + user message)
        tools: Available MCP tools
        images: Optional image attachments (added to last user message)

    Returns:
        Generator that yields sentence-chunked messages
    """
    # Add images to the last message if provided
    if images and messages:
        # Find the last user message and add images to it
        for msg in reversed(messages):
            if msg.get("role") == "user":
                msg["images"] = images
                break

    # Call LLM provider
    try:
        stream = _llm_provider.chat(
            model=model_name,
            messages=messages,
            tools=tools or [],
            stream=True,
        )
    except Exception as e:
        logger.error(f"Error calling LLM provider (model={model_name}): {e}", exc_info=True)
        raise

    # Generator that processes the stream and chunks into sentences
    def sentence_chunked_generator():
        delimiters = [".", "\n", "?", ":", "!", ";"]
        buffer = ""
        thinking_buffer = ""

        try:
            for chunk in stream:
                msg = chunk.message

                # Stream thinking content as it arrives
                thinking_content = getattr(msg, 'thinking', None)
                if thinking_content:
                    thinking_buffer += thinking_content

                    # Yield thinking chunks immediately
                    created_at = datetime.datetime.utcnow().isoformat()
                    thinking_message = {
                        "role": "assistant",
                        "content": "",  # No content, just thinking
                        "thinking": thinking_content,
                        "created_at": created_at,
                    }
                    yield thinking_message

                buffer += msg.content

                # Sentence chunking: Find the last occurrence of any delimiter in the buffer
                last_delimiter_pos = -1
                for delimiter in delimiters:
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
                        message = {
                            "role": "assistant",
                            "content": complete_sentence,
                            "created_at": created_at,
                        }
                        yield message

                        # Keep the remaining part in buffer
                        buffer = buffer[last_delimiter_pos + 1:]

            # Yield any remaining buffer content
            rstrip_buffer = buffer.rstrip()
            if rstrip_buffer:
                created_at = datetime.datetime.utcnow().isoformat()
                message = {
                    "role": "assistant",
                    "content": rstrip_buffer,
                    "created_at": created_at,
                }
                yield message

        except Exception as e:
            logger.error(f"Error processing LLM stream response: {e}", exc_info=True)
            raise

    return sentence_chunked_generator()


def list_models() -> List[str]:
    """Return a list of available model names."""
    try:
        return _llm_provider.list_models()
    except Exception as e:
        logger.error(f"Error listing models from LLM provider: {e}", exc_info=True)
        raise


def generate(payload: Dict, user_system_prompts: Optional[List[Dict]] = None) -> str:
    """Generate text using the LLM's generate API.

    Unlike chat, this doesn't maintain conversation history and is suitable
    for one-off text generation tasks like title generation.

    Args:
        payload: Payload with model, message, and options
        user_system_prompts: Optional user-specific system prompts

    Returns:
        Generated text
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

    try:
        return _llm_provider.generate(
            model=model,
            prompt=full_prompt,
            options=options,
            stream=False,
        )
    except Exception as e:
        logger.error(f"Error generating text with LLM provider (model={model}): {e}", exc_info=True)
        raise


def pull_model(model_name: str) -> None:
    """Pull a model from the LLM provider's registry."""
    try:
        _llm_provider.pull_model(model_name)
    except Exception as e:
        logger.error(f"Error pulling model '{model_name}' from LLM provider: {e}", exc_info=True)
        raise
