"""Unexpected exception text must not reach the caller.

Almost every router used to end its handler with ``detail=str(e)``. That text is
rarely harmless: a SQLAlchemy error carries the failing SQL and often its
parameters, an httpx error carries the internal service URL, and a filesystem
error carries absolute server paths.

The pattern spread because it was documented as the house style, so a static
check is the right guard — the next person to copy a handler gets a failing test
rather than a reviewer's memory.
"""

import ast
import inspect
from pathlib import Path

import pytest
from fastapi import HTTPException

import kurisuassistant
from kurisuassistant.core.errors import GENERIC_MESSAGE, internal_error, log_internal_error

PACKAGE_ROOT = Path(inspect.getfile(kurisuassistant)).parent
ROUTERS = sorted((PACKAGE_ROOT / "routers").glob("*.py"))


def leaking_details(tree: ast.Module):
    """Find `detail=str(e)` and `detail=f"...{e}"` in HTTPException calls."""
    offenders = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "HTTPException"):
            continue
        for keyword in node.keywords:
            if keyword.arg != "detail":
                continue
            value = keyword.value
            # detail=str(e)
            if isinstance(value, ast.Call) and getattr(value.func, "id", None) == "str":
                if value.args and isinstance(value.args[0], ast.Name) and value.args[0].id in ("e", "exc"):
                    offenders.append(node.lineno)
            # detail=f"... {e} ..."
            elif isinstance(value, ast.JoinedStr):
                for part in value.values:
                    if isinstance(part, ast.FormattedValue) and isinstance(part.value, ast.Name):
                        if part.value.id in ("e", "exc"):
                            offenders.append(node.lineno)
    return offenders


class TestRoutersDoNotEchoExceptions:
    @pytest.mark.parametrize("path", ROUTERS, ids=lambda p: p.name)
    def test_no_raw_exception_in_detail(self, path):
        source = path.read_text()
        offenders = leaking_details(ast.parse(source, filename=str(path)))

        # A deliberately-raised ValueError carries a message this code wrote, so
        # those stay: they are the actionable 4xx messages a caller can act on.
        allowed = set()
        for lineno in offenders:
            line_index = lineno - 1
            window = source.split("\n")[max(0, line_index - 3):line_index + 1]
            if any("except ValueError" in line for line in window):
                allowed.add(lineno)

        unexpected = [lineno for lineno in offenders if lineno not in allowed]
        assert not unexpected, (
            f"{path.name} puts raw exception text in a response at line(s) {unexpected}. "
            "Use internal_error(e, 'context') so the detail stays generic and the "
            "exception reaches the log instead."
        )


class TestWebSocketErrorsAreGeneric:
    def test_no_raw_exception_in_error_events(self):
        source = (PACKAGE_ROOT / "websocket" / "handlers.py").read_text()
        assert "ErrorEvent(error=str(e)" not in source, (
            "The socket must not echo exception text; use log_internal_error and "
            "send the reference instead."
        )


class TestInternalErrorHelper:
    def test_the_detail_says_nothing_specific(self):
        secret = "FATAL: password authentication failed for user 'kurisu'"
        exc = internal_error(RuntimeError(secret), "doing a thing")
        assert isinstance(exc, HTTPException)
        assert secret not in exc.detail
        assert GENERIC_MESSAGE in exc.detail

    def test_the_detail_carries_a_reference(self):
        exc = internal_error(RuntimeError("boom"), "doing a thing")
        assert "reference:" in exc.detail

    def test_each_error_gets_its_own_reference(self):
        first = internal_error(RuntimeError("boom"), "a")
        second = internal_error(RuntimeError("boom"), "b")
        assert first.detail != second.detail

    def test_the_detail_stays_a_string(self):
        """Clients read detail directly to show a message; an object would break them."""
        assert isinstance(internal_error(RuntimeError("boom"), "a").detail, str)

    def test_the_status_code_can_be_overridden(self):
        exc = internal_error(RuntimeError("boom"), "upstream", status_code=502)
        assert exc.status_code == 502

    def test_a_public_detail_replaces_the_generic_message(self):
        exc = internal_error(
            RuntimeError("connection refused to http://internal:14213"),
            "upstream", status_code=502, public_detail="The speech service is unavailable.",
        )
        assert "The speech service is unavailable." in exc.detail
        assert "internal:14213" not in exc.detail

    def test_the_exception_is_logged_with_its_reference(self, caplog):
        import logging

        with caplog.at_level(logging.ERROR):
            reference = log_internal_error(RuntimeError("the real cause"), "doing a thing")

        assert reference in caplog.text
        assert "the real cause" in caplog.text, "the operator still needs the detail"
