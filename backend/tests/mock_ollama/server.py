"""A mock Ollama server: the slice of the Ollama HTTP API the backend uses, served
deterministically to the real ``ollama`` client.

Why a server and not another fake provider: the fakes in the unit tests stop at
``OllamaProvider``. Everything below it — the ``ollama`` client's request shape,
its pydantic parsing of the NDJSON stream, how tool calls and ``thinking`` come
back — is only exercised against a live daemon, which CI does not have and which
costs money when the model is a cloud one. This speaks the wire format instead,
so ``OllamaProvider`` runs unmodified and the client validates every response.

Endpoints: ``GET /api/tags``, ``POST /api/show``, ``POST /api/pull``,
``DELETE /api/delete``, ``GET /api/version``, ``GET /api/ps``, ``POST /api/chat``
(streaming NDJSON or one JSON body; honours ``stream``, ``tools``, ``think``,
``options``), ``POST /api/generate``, ``POST /api/embed``.

Behaviour is deterministic by default and scriptable:

- With nothing queued, ``/api/chat`` answers ``You said: <last user message>``
  streamed one word at a time, adds a ``thinking`` chunk when ``think`` is set,
  answers a ``tool`` message with ``The tool returned: …``, and turns a user
  message of the form ``call <tool> {json}`` into a tool call when that tool was
  offered — enough to drive a client through a whole tool loop by hand.
- ``MockOllamaState.script(Reply(...), ...)`` queues exact replies (content,
  thinking, tool calls, chunking, delay, or an HTTP error) that ``/api/chat`` and
  ``/api/generate`` consume in order. The same is reachable over HTTP for a mock
  running in a container: ``POST /_mock/replies``, ``GET /_mock/requests``,
  ``DELETE /_mock/requests``, ``POST /_mock/reset``, ``GET /_mock/state``.
- ``/api/embed`` answers a deterministic unit vector per text — seeded from the
  text, so the same string always embeds the same way and different strings
  land somewhere unrelated. ``MockOllamaState.script_embedding(text, vector)``
  pins a vector for one exact string, which is how a test puts two texts near
  each other; ``fail_embeddings(status)`` makes the endpoint answer that error
  until reset. Over HTTP: ``POST /_mock/embeddings``.
- Every ``/api/chat``, ``/api/generate``, ``/api/pull`` and ``/api/embed`` request
  is recorded with its body, so a test can assert on what the backend actually
  sent.

Unknown models are refused with Ollama's own 404 unless ``auto_pull`` is on, in
which case ``/api/pull`` adds them — which is what ``OllamaProvider`` does before
every chat, so the default flow needs no setup.

Run standalone with ``python -m tests.mock_ollama --port 11435`` and point a
backend at it with ``LLM_API_URL``; in tests use the ``mock_ollama`` fixture from
``conftest.py``.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional, Sequence

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

DEFAULT_MODEL = "mock-model:latest"
CONTEXT_LENGTH = 8192
VERSION = "0.0.0-mock"
EMBED_DIMENSIONS = 16

_CALL_DIRECTIVE = re.compile(r"^call\s+([A-Za-z0-9_.:-]+)(?:\s+(\{.*\}))?\s*$", re.S)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _words(text: str) -> List[str]:
    """Split so that ``"".join(_words(t)) == t``; whitespace rides with its word."""
    return re.findall(r"\S+\s*|\s+", text)


def _token_estimate(messages: Sequence[Dict[str, Any]]) -> int:
    return sum(len(str(m.get("content") or "").split()) for m in messages)


# --- scripting ------------------------------------------------------------------

@dataclass
class ToolCall:
    name: str
    arguments: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Reply:
    """One scripted answer. ``status`` turns it into an HTTP error instead."""

    content: str = ""
    thinking: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    #: Words per streamed chunk; the real daemon streams roughly per token.
    words_per_chunk: int = 1
    #: Pause between streamed chunks, for clients that need to observe streaming.
    delay_ms: int = 0
    status: Optional[int] = None
    error: str = ""
    done_reason: str = "stop"

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Reply":
        calls = [ToolCall(tc["name"], dict(tc.get("arguments") or {})) for tc in d.get("tool_calls") or []]
        return cls(
            content=d.get("content", ""),
            thinking=d.get("thinking", ""),
            tool_calls=calls,
            words_per_chunk=int(d.get("words_per_chunk", 1)),
            delay_ms=int(d.get("delay_ms", 0)),
            status=d.get("status"),
            error=d.get("error", ""),
            done_reason=d.get("done_reason", "stop"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "content": self.content,
            "thinking": self.thinking,
            "tool_calls": [{"name": tc.name, "arguments": tc.arguments} for tc in self.tool_calls],
            "words_per_chunk": self.words_per_chunk,
            "delay_ms": self.delay_ms,
            "status": self.status,
            "error": self.error,
            "done_reason": self.done_reason,
        }


def default_reply(body: Dict[str, Any]) -> Reply:
    """What the mock says when nothing is scripted."""
    messages = body.get("messages") or []
    last = messages[-1] if messages else {}
    text = str(last.get("content") or "").strip()

    if last.get("role") == "tool":
        return Reply(content=f"The tool returned: {text}")

    match = _CALL_DIRECTIVE.match(text)
    if match:
        name, raw_args = match.group(1), match.group(2)
        offered = {
            (t.get("function") or {}).get("name") for t in body.get("tools") or [] if isinstance(t, dict)
        }
        if name in offered:
            return Reply(tool_calls=[ToolCall(name, json.loads(raw_args) if raw_args else {})])
        return Reply(content=f"No tool named {name} was offered.")

    thinking = f"The user said {text!r}; a short acknowledgement will do." if body.get("think") else ""
    return Reply(content=f"You said: {text}" if text else "Hello from the mock.", thinking=thinking)


# --- state ----------------------------------------------------------------------

class MockOllamaState:
    """Models, queued replies and the request log. Safe to touch from a test
    thread while the server thread serves."""

    def __init__(self, models: Sequence[str] = (DEFAULT_MODEL,), auto_pull: bool = True):
        self._initial = [self._canonical(m) for m in models]
        self.models: List[str] = list(self._initial)
        self.auto_pull = auto_pull
        self.replies: List[Reply] = []
        self.requests: List[Dict[str, Any]] = []
        self.embeddings: Dict[str, List[float]] = {}
        self.embed_fail_status: Optional[int] = None
        self._lock = threading.Lock()

    @staticmethod
    def _canonical(name: str) -> str:
        return name if ":" in name else f"{name}:latest"

    def has_model(self, name: str) -> bool:
        return self._canonical(name) in self.models

    def add_model(self, name: str) -> None:
        with self._lock:
            name = self._canonical(name)
            if name not in self.models:
                self.models.append(name)

    def remove_model(self, name: str) -> bool:
        with self._lock:
            name = self._canonical(name)
            if name in self.models:
                self.models.remove(name)
                return True
            return False

    def script(self, *replies: Reply) -> None:
        with self._lock:
            self.replies.extend(replies)

    def pop_reply(self) -> Optional[Reply]:
        with self._lock:
            return self.replies.pop(0) if self.replies else None

    def script_embedding(self, text: str, vector: Sequence[float]) -> None:
        """Pin the vector ``/api/embed`` returns for exactly ``text``."""
        with self._lock:
            self.embeddings[text] = [float(v) for v in vector]

    def fail_embeddings(self, status: Optional[int]) -> None:
        """Make ``/api/embed`` answer ``status`` (``None`` restores it)."""
        with self._lock:
            self.embed_fail_status = status

    def embedding_for(self, text: str) -> List[float]:
        with self._lock:
            pinned = self.embeddings.get(text)
        return list(pinned) if pinned is not None else default_embedding(text)

    def record(self, endpoint: str, body: Dict[str, Any]) -> None:
        with self._lock:
            self.requests.append({"endpoint": endpoint, "received_at": _now(), **body})

    def requests_to(self, endpoint: str) -> List[Dict[str, Any]]:
        with self._lock:
            return [r for r in self.requests if r["endpoint"] == endpoint]

    def clear_requests(self) -> None:
        with self._lock:
            self.requests.clear()

    def reset(self) -> None:
        with self._lock:
            self.models = list(self._initial)
            self.replies.clear()
            self.requests.clear()
            self.embeddings.clear()
            self.embed_fail_status = None

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "models": list(self.models),
                "auto_pull": self.auto_pull,
                "queued_replies": len(self.replies),
                "requests": len(self.requests),
                "pinned_embeddings": len(self.embeddings),
                "embed_fail_status": self.embed_fail_status,
            }


def default_embedding(text: str) -> List[float]:
    """A unit vector seeded from ``text``: stable per string, unrelated across strings."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    raw = [((digest[i % len(digest)] ^ (i * 37 & 0xFF)) / 127.5) - 1.0 for i in range(EMBED_DIMENSIONS)]
    # Two bytes per component keeps 16 components from repeating the digest.
    raw = [raw[i] + (digest[(i + 7) % len(digest)] / 255.0 - 0.5) for i in range(EMBED_DIMENSIONS)]
    norm = sum(v * v for v in raw) ** 0.5 or 1.0
    return [round(v / norm, 6) for v in raw]


# --- the app --------------------------------------------------------------------

def _model_entry(name: str) -> Dict[str, Any]:
    return {
        "name": name,
        "model": name,
        "modified_at": _now(),
        "size": 1_000_000,
        "digest": hashlib.sha256(name.encode()).hexdigest(),
        "details": {
            "parent_model": "",
            "format": "gguf",
            "family": "mock",
            "families": ["mock"],
            "parameter_size": "1B",
            "quantization_level": "Q4_0",
        },
    }


def _not_found(model: str) -> JSONResponse:
    return JSONResponse({"error": f"model '{model}' not found, try pulling it first"}, status_code=404)


def _durations(prompt_tokens: int, eval_tokens: int) -> Dict[str, int]:
    return {
        "total_duration": 5_000_000 * (prompt_tokens + eval_tokens + 1),
        "load_duration": 1_000_000,
        "prompt_eval_count": prompt_tokens,
        "prompt_eval_duration": 1_000_000 * (prompt_tokens + 1),
        "eval_count": eval_tokens,
        "eval_duration": 4_000_000 * (eval_tokens + 1),
    }


def _tool_calls_json(reply: Reply) -> List[Dict[str, Any]]:
    return [{"function": {"name": tc.name, "arguments": tc.arguments}} for tc in reply.tool_calls]


def _chat_stream(model: str, reply: Reply, prompt_tokens: int) -> Iterator[bytes]:
    def line(message: Dict[str, Any], done: bool = False, **extra: Any) -> bytes:
        return (json.dumps({"model": model, "created_at": _now(), "message": message, "done": done, **extra}) + "\n").encode()

    def pause() -> None:
        if reply.delay_ms:
            time.sleep(reply.delay_ms / 1000)

    def chunks(text: str) -> Iterator[str]:
        words = _words(text)
        for i in range(0, len(words), max(1, reply.words_per_chunk)):
            yield "".join(words[i:i + max(1, reply.words_per_chunk)])

    eval_tokens = 0
    for piece in chunks(reply.thinking):
        eval_tokens += 1
        yield line({"role": "assistant", "content": "", "thinking": piece})
        pause()
    for piece in chunks(reply.content):
        eval_tokens += 1
        yield line({"role": "assistant", "content": piece})
        pause()
    if reply.tool_calls:
        eval_tokens += len(reply.tool_calls)
        yield line({"role": "assistant", "content": "", "tool_calls": _tool_calls_json(reply)})
    yield line({"role": "assistant", "content": ""}, done=True, done_reason=reply.done_reason,
               **_durations(prompt_tokens, eval_tokens))


def _generate_stream(model: str, reply: Reply, prompt_tokens: int) -> Iterator[bytes]:
    words = _words(reply.content)
    for i in range(0, len(words), max(1, reply.words_per_chunk)):
        piece = "".join(words[i:i + max(1, reply.words_per_chunk)])
        yield (json.dumps({"model": model, "created_at": _now(), "response": piece, "done": False}) + "\n").encode()
        if reply.delay_ms:
            time.sleep(reply.delay_ms / 1000)
    yield (json.dumps({"model": model, "created_at": _now(), "response": "", "done": True,
                       "done_reason": reply.done_reason, "context": [],
                       **_durations(prompt_tokens, len(words))}) + "\n").encode()


def create_app(state: MockOllamaState) -> FastAPI:
    app = FastAPI(title="mock-ollama", docs_url=None, redoc_url=None)

    async def body_of(request: Request) -> Dict[str, Any]:
        raw = await request.body()
        if not raw:
            return {}
        return json.loads(raw)

    def model_of(body: Dict[str, Any]) -> str:
        return str(body.get("model") or body.get("name") or "")

    @app.get("/")
    @app.head("/")
    async def root():
        return PlainTextResponse("Ollama is running")

    @app.get("/api/version")
    async def version():
        return {"version": VERSION}

    @app.get("/api/tags")
    async def tags():
        return {"models": [_model_entry(m) for m in list(state.models)]}

    @app.get("/api/ps")
    async def ps():
        return {"models": []}

    @app.post("/api/show")
    async def show(request: Request):
        model = model_of(await body_of(request))
        if not state.has_model(model):
            return _not_found(model)
        entry = _model_entry(state._canonical(model))
        return {
            "modelfile": f"FROM {model}",
            "parameters": "",
            "template": "{{ .Prompt }}",
            "details": entry["details"],
            "model_info": {"general.architecture": "mock", "mock.context_length": CONTEXT_LENGTH},
            "capabilities": ["completion", "tools", "thinking"],
            "modified_at": entry["modified_at"],
        }

    @app.post("/api/pull")
    async def pull(request: Request):
        body = await body_of(request)
        model = model_of(body)
        state.record("/api/pull", body)
        if not state.has_model(model):
            if not state.auto_pull:
                return JSONResponse({"error": f"pull model manifest: file does not exist: {model}"}, status_code=404)
            state.add_model(model)
        if body.get("stream", True):
            def progress() -> Iterator[bytes]:
                for status in ("pulling manifest", "verifying sha256 digest", "writing manifest", "success"):
                    yield (json.dumps({"status": status}) + "\n").encode()
            return StreamingResponse(progress(), media_type="application/x-ndjson")
        return {"status": "success"}

    @app.delete("/api/delete")
    async def delete(request: Request):
        model = model_of(await body_of(request))
        if not state.remove_model(model):
            return _not_found(model)
        return {"status": "success"}

    @app.post("/api/chat")
    async def chat(request: Request):
        body = await body_of(request)
        model = model_of(body)
        state.record("/api/chat", body)
        if not state.has_model(model):
            return _not_found(model)
        reply = state.pop_reply() or default_reply(body)
        if reply.status:
            return JSONResponse({"error": reply.error or "scripted error"}, status_code=reply.status)
        prompt_tokens = _token_estimate(body.get("messages") or [])
        if body.get("stream", True):
            return StreamingResponse(_chat_stream(model, reply, prompt_tokens), media_type="application/x-ndjson")
        message: Dict[str, Any] = {"role": "assistant", "content": reply.content}
        if reply.thinking:
            message["thinking"] = reply.thinking
        if reply.tool_calls:
            message["tool_calls"] = _tool_calls_json(reply)
        eval_tokens = len(_words(reply.thinking)) + len(_words(reply.content)) + len(reply.tool_calls)
        return {"model": model, "created_at": _now(), "message": message, "done": True,
                "done_reason": reply.done_reason, **_durations(prompt_tokens, eval_tokens)}

    @app.post("/api/generate")
    async def generate(request: Request):
        body = await body_of(request)
        model = model_of(body)
        state.record("/api/generate", body)
        if not state.has_model(model):
            return _not_found(model)
        prompt = str(body.get("prompt") or "").strip()
        reply = state.pop_reply() or Reply(content=f"You said: {prompt}" if prompt else "Hello from the mock.")
        if reply.status:
            return JSONResponse({"error": reply.error or "scripted error"}, status_code=reply.status)
        prompt_tokens = len(prompt.split())
        if body.get("stream", True):
            return StreamingResponse(_generate_stream(model, reply, prompt_tokens), media_type="application/x-ndjson")
        return {"model": model, "created_at": _now(), "response": reply.content, "done": True,
                "done_reason": reply.done_reason, "context": [],
                **_durations(prompt_tokens, len(_words(reply.content)))}

    @app.post("/api/embed")
    async def embed(request: Request):
        body = await body_of(request)
        model = model_of(body)
        state.record("/api/embed", body)
        if not state.has_model(model):
            return _not_found(model)
        if state.embed_fail_status:
            return JSONResponse({"error": "scripted embedding failure"}, status_code=state.embed_fail_status)
        inputs = body.get("input")
        if inputs is None:
            return JSONResponse({"error": "input is required"}, status_code=400)
        if isinstance(inputs, str):
            inputs = [inputs]
        vectors = [state.embedding_for(str(text)) for text in inputs]
        prompt_tokens = sum(len(_words(str(text))) for text in inputs)
        return {"model": model, "embeddings": vectors,
                "total_duration": 1_000_000, "load_duration": 100_000,
                "prompt_eval_count": prompt_tokens}

    # -- control surface, for a mock that runs in a container ------------------

    @app.get("/_mock/state")
    async def mock_state():
        return state.snapshot()

    @app.post("/_mock/replies")
    async def mock_replies(request: Request):
        body = await body_of(request)
        replies = [Reply.from_dict(r) for r in body.get("replies") or []]
        state.script(*replies)
        return {"queued": state.snapshot()["queued_replies"]}

    @app.post("/_mock/embeddings")
    async def mock_embeddings(request: Request):
        body = await body_of(request)
        for text, vector in (body.get("embeddings") or {}).items():
            state.script_embedding(text, vector)
        if "fail_status" in body:
            state.fail_embeddings(body["fail_status"])
        return {"pinned": len(state.embeddings), "fail_status": state.embed_fail_status}

    @app.get("/_mock/requests")
    async def mock_requests():
        return {"requests": list(state.requests)}

    @app.delete("/_mock/requests")
    async def mock_clear_requests():
        state.clear_requests()
        return {"requests": 0}

    @app.post("/_mock/reset")
    async def mock_reset():
        state.reset()
        return state.snapshot()

    return app


# --- in-process server ----------------------------------------------------------

class MockOllamaServer:
    """The mock on a background thread, on a random free port unless told otherwise.

    >>> with MockOllamaServer() as mock:
    ...     OllamaProvider(api_url=mock.url).list_models()
    """

    def __init__(self, models: Sequence[str] = (DEFAULT_MODEL,), auto_pull: bool = True,
                 host: str = "127.0.0.1", port: int = 0):
        self.state = MockOllamaState(models, auto_pull)
        self.app = create_app(self.state)
        self._host = host
        self._port = port
        self._server: Optional[uvicorn.Server] = None
        self._thread: Optional[threading.Thread] = None

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self._port}"

    def start(self) -> str:
        config = uvicorn.Config(self.app, host=self._host, port=self._port, log_level="warning",
                                lifespan="off", access_log=False)
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, name="mock-ollama", daemon=True)
        self._thread.start()
        deadline = time.time() + 10
        while not self._server.started:
            if time.time() > deadline or not self._thread.is_alive():
                raise RuntimeError("mock Ollama did not start")
            time.sleep(0.01)
        self._port = self._server.servers[0].sockets[0].getsockname()[1]
        return self.url

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=5)

    def __enter__(self) -> "MockOllamaServer":
        self.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop()
