"""Poe LLM provider.

Poe fronts Claude, GPT, Gemini, Grok, Llama, Kimi and others behind one
subscription's points, through an OpenAI-dialect endpoint at api.poe.com/v1. The
shared implementation is ``openai_compat.py``; what is specific to Poe, all checked
against the live API on 2026-09-05:

- ``GET /models`` is public and lists every bot — image, video and audio generators
  included — so the catalogue is filtered to text-output models that serve
  ``/v1/chat/completions``. Entries without ``supported_endpoints`` are kept; most
  text bots omit the field.
- Because the catalogue needs no key, a key cannot be validated by listing models.
  ``validate_key`` sends a one-token request for a model that does not exist: a bad
  key is refused with 401 before the model is looked up, a good one gets a 404 for
  the model and spends nothing.
- Reasoning summaries exist only on Poe's Responses API, so ``think`` adds nothing
  to a chat-completions request; a model that reasons does so internally.
- Errors arrive as ``{"error": {"type", "code", "message"}}`` with ``type`` one of
  authentication_error, insufficient_credits, rate_limit_error, not_found_error,
  moderation_error, provider_error; the message is surfaced as-is.
"""

from typing import Any, Dict

import requests

from .openai_compat import OpenAICompatibleProvider

POE_BASE_URL = "https://api.poe.com/v1"

#: Deliberately not a bot. See ``PoeProvider.validate_key``.
_KEY_CHECK_MODEL = "kurisu-key-check-no-such-model"


class PoeProvider(OpenAICompatibleProvider):
    """Poe implementation of BaseLLMProvider."""

    PROVIDER_NAME = "Poe"
    DEFAULT_BASE_URL = POE_BASE_URL
    API_KEY_ENV = "POE_API_KEY"

    def _extend_payload(self, payload: Dict[str, Any], *, think: bool, options: Dict[str, Any]) -> None:
        # Poe caps output per model itself; only an explicit Ollama-style
        # num_predict is passed on. num_ctx is a context size, not an output cap.
        if options.get("num_predict"):
            payload["max_tokens"] = int(options["num_predict"])

    def _model_filter(self, entry: Dict[str, Any]) -> bool:
        arch = entry.get("architecture") or {}
        if "text" not in (arch.get("output_modalities") or ["text"]):
            return False
        endpoints = entry.get("supported_endpoints") or []
        return not endpoints or "/v1/chat/completions" in endpoints

    def validate_key(self) -> int:
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json={
                "model": _KEY_CHECK_MODEL,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1,
                "stream": False,
            },
            timeout=self.REQUEST_TIMEOUT,
        )
        if resp.status_code in (401, 403):
            raise PermissionError(self._error_message(resp))
        if resp.status_code >= 500:
            raise requests.HTTPError(self._error_message(resp), response=resp)
        # Anything else — 404 for the made-up model, 402 for an account out of
        # points, 429 — means the key itself was accepted.
        return len(self._list_models_raw())
