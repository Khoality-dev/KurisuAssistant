"""A release is a tag alone (#291).

Pushing ``vX.Y.Z`` on ``main`` is the whole release: nothing in the tree holds
the number. The backend learns its version from the image it runs in — the
deployment stamps ``KURISU_VERSION`` from the checked-out tag when it builds —
and anything that is not a plain release number says so, so a dev build is
never mistaken for a release. The clients still take their version from the
tag at build time, and ``release.yml`` asks ``version.release_tag_problem``
whether a tag is one it may release.
"""

import importlib
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from kurisuassistant import version

VERSION_PY = Path(version.__file__)
BACKEND = VERSION_PY.parents[1]
RELEASE_YML = BACKEND.parent / ".github" / "workflows" / "release.yml"


@pytest.mark.parametrize("raw, expected", [("0.8.0", "0.8.0"), ("v0.8.0", "0.8.0"), (" v1.2.3\n", "1.2.3")])
def test_a_release_tag_is_the_version(raw, expected):
    assert version.resolve_version(raw) == expected
    assert version.is_release(expected)


@pytest.mark.parametrize("raw", ["v0.8.0-3-gc3fa067", "c3fa067", "v0.8.0-dirty", "0.8.0rc1"])
def test_a_build_from_anything_else_is_not_a_release(raw):
    resolved = version.resolve_version(raw)
    assert resolved == raw.strip().removeprefix("v")
    assert not version.is_release(resolved)


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_an_unstamped_build_says_dev(raw):
    assert version.resolve_version(raw) == "dev"
    assert not version.is_release("dev")


def test_the_version_is_read_from_the_image_it_runs_in(monkeypatch):
    monkeypatch.setenv("KURISU_VERSION", "v1.2.3")
    try:
        assert importlib.reload(version).__version__ == "1.2.3"
    finally:
        monkeypatch.delenv("KURISU_VERSION")
        importlib.reload(version)
    assert version.__version__ == "dev"


def test_no_release_number_is_committed():
    assert not re.search(r"^__version__\s*=\s*[\"']\d", VERSION_PY.read_text(), re.M)


@pytest.mark.parametrize("tag", ["v0.8.0", "v1.0.0", "v2.99.99"])
def test_a_release_tag_passes_the_workflow_check(tag):
    assert version.release_tag_problem(tag) is None


@pytest.mark.parametrize(
    "tag", ["0.8.0", "v0.8", "v0.8.0.1", "v0.8.0-rc1", "release-0.8.0", "", "v0.100.0", "v0.8.100"]
)
def test_anything_else_is_refused_with_a_reason(tag):
    # Minor and patch stay under 100: Android's versionCode is X*10000 + Y*100 + Z.
    problem = version.release_tag_problem(tag)
    assert isinstance(problem, str) and problem


def test_the_check_runs_as_a_script_the_workflow_can_call():
    ok = subprocess.run([sys.executable, str(VERSION_PY), "v0.8.0"], capture_output=True, text=True)
    bad = subprocess.run([sys.executable, str(VERSION_PY), "v0.8"], capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    assert bad.returncode == 1 and bad.stderr.strip()


def test_the_release_workflow_asks_the_check_and_reads_no_committed_number():
    workflow = RELEASE_YML.read_text()
    assert "python3 backend/kurisuassistant/version.py" in workflow
    assert "__version__" not in workflow


def test_the_release_workflow_refuses_a_tag_that_is_not_on_main():
    workflow = RELEASE_YML.read_text()
    assert "merge-base --is-ancestor" in workflow and "origin/main" in workflow


def test_the_image_is_stamped_with_the_version_it_is_built_from():
    dockerfile = (BACKEND / "Dockerfile").read_text()
    assert re.search(r"^ARG KURISU_VERSION\b", dockerfile, re.M)
    assert re.search(r"^ENV KURISU_VERSION=\$\{?KURISU_VERSION\}?\s*$", dockerfile, re.M)
    build = yaml.safe_load((BACKEND / "docker-compose.yml").read_text())["services"]["api"]["build"]
    args = build.get("args") or {}
    names = args.keys() if isinstance(args, dict) else [a.split("=", 1)[0] for a in args]
    assert "KURISU_VERSION" in names
