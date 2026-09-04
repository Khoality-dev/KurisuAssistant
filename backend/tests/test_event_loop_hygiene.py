"""Nothing on the request path may block the event loop.

The server runs a single uvicorn worker, so one blocking call freezes every
connected client, not just the caller. Two habits caused that:

  * proxying to the speech service with the synchronous `requests` library from
    inside an `async def` handler, for up to two minutes per synthesis;
  * calling DBService.execute_sync — which blocks on a cross-thread future with
    no timeout — from coroutines in the WebSocket handler.

Both are invisible at runtime: everything still works, just slowly and for
everyone. These are static checks over the source, because that is the only way
to catch the pattern coming back in code that no unit test exercises.
"""

import ast
import inspect
from pathlib import Path

import pytest

import kurisuassistant
from kurisuassistant.websocket import handlers as handlers_module

PACKAGE_ROOT = Path(inspect.getfile(kurisuassistant)).parent
ROUTERS = sorted((PACKAGE_ROOT / "routers").glob("*.py"))


def parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(), filename=str(path))


def imported_names(tree: ast.Module) -> set:
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


class TestNoSynchronousHttpInRouters:
    """Outbound calls from a router must use the shared async client."""

    @pytest.mark.parametrize("path", ROUTERS, ids=lambda p: p.name)
    def test_router_does_not_import_requests(self, path):
        assert "requests" not in imported_names(parse(path)), (
            f"{path.name} imports the synchronous 'requests' library. Use "
            "kurisuassistant.core.http.get_client() and await the call instead."
        )

    def test_speech_routers_use_the_shared_client(self):
        for name in ("asr.py", "tts.py"):
            source = (PACKAGE_ROOT / "routers" / name).read_text()
            assert "get_client()" in source, f"{name} should proxy through the shared async client"

    def test_speech_route_handlers_are_async(self):
        for name in ("asr.py", "tts.py"):
            tree = parse(PACKAGE_ROOT / "routers" / name)
            for node in tree.body:
                if isinstance(node, ast.FunctionDef) and node.decorator_list:
                    decorated_by_router = any(
                        isinstance(d, ast.Call)
                        and isinstance(d.func, ast.Attribute)
                        and getattr(d.func.value, "id", None) == "router"
                        for d in node.decorator_list
                    )
                    assert not decorated_by_router, (
                        f"{name}:{node.name} is a synchronous route handler; it should be async"
                    )


class TestNoBlockingDatabaseCallsOnTheLoop:
    """execute_sync belongs in worker threads, not in coroutines."""

    def test_handler_coroutines_do_not_call_execute_sync(self):
        tree = parse(Path(inspect.getfile(handlers_module)))

        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncFunctionDef):
                continue
            for inner in ast.walk(node):
                # A nested sync def inside a coroutine is a worker-thread target,
                # so only flag calls made directly in the async body.
                if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute):
                    if inner.func.attr == "execute_sync":
                        offenders.append(f"{node.name}:{inner.lineno}")

        assert not offenders, (
            "execute_sync called from a coroutine, which blocks the event loop for the "
            f"whole query: {offenders}. Use `await db.execute(...)` instead."
        )

    def test_the_remaining_execute_sync_is_a_worker_thread_target(self):
        """_create_summary_conversation is legitimately sync: it runs under to_thread."""
        source = Path(inspect.getfile(handlers_module)).read_text()
        assert source.count("execute_sync") == 1, (
            "Exactly one execute_sync should remain, in _create_summary_conversation"
        )
        assert "asyncio.to_thread(\n            self._create_summary_conversation" in source or \
               "self._create_summary_conversation," in source


class TestSkillLookupIsAwaited:
    """Building the system prompt happens inside the streaming coroutine."""

    def test_get_skill_names_is_a_coroutine(self):
        from kurisuassistant.tools.skills import get_skill_names_for_user
        assert inspect.iscoroutinefunction(get_skill_names_for_user)

    def test_prepare_messages_is_a_coroutine(self):
        from kurisuassistant.agents.main import MainAgent
        assert inspect.iscoroutinefunction(MainAgent._prepare_messages)
