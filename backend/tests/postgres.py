"""What a test does when Postgres does not answer.

Off CI, skip: a developer without a database still gets the rest of the suite.
On CI the workflow provides one, so a missing database is a broken run, and a
skip would hide every test behind it — three migration suites used to do exactly
that (#307). Every "no Postgres" skip goes through here;
``test_suite_isolation.py`` fails on one that does not.
"""

import os

import pytest


def require_postgres(exc: BaseException, what: str) -> None:
    """Skip ``what`` for want of Postgres, or raise when running on CI."""
    if os.environ.get("CI"):
        raise RuntimeError(f"no Postgres for {what} on CI: {exc}") from exc
    pytest.skip(f"no Postgres for {what}: {exc}")
