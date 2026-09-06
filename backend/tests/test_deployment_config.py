"""The deployment files, checked as data.

Nothing tested the Compose stack, so it drifted into working on exactly one
machine: absolute paths under one developer's home directory as build contexts,
an external network nothing creates, a GPU reservation that fails on any host
without the NVIDIA runtime, and no published port at all — a successful
`docker compose up -d` produced a server no client could reach (issue #98).

Every assertion here is a property a fresh self-hoster depends on, and each one
was false at some point. These are string and YAML checks; they need no Docker
and run in the normal unit suite.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

BACKEND = Path(__file__).resolve().parent.parent

BASE = BACKEND / "docker-compose.yml"
DEV = BACKEND / "docker-compose.dev.yml"
ENV_TEMPLATE = BACKEND / ".env.template"

# Two, deliberately: production and the dev overlay. Optional pieces are
# profiles inside the production file, not more files.
ALL_COMPOSE = [BASE, DEV]


def load(path: Path) -> dict:
    """Parse a Compose file, tolerating Compose's own YAML tags.

    `!override` and `!reset` decorate an ordinary value; the tag itself carries
    merge semantics we do not need here, so it is dropped and the value kept.
    (Re-dispatching the tagged node through `construct_object` would find the
    same tag again, which is a loop.)
    """

    class ComposeLoader(yaml.SafeLoader):
        pass

    def untagged(loader, node):
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node, deep=True)
        if isinstance(node, yaml.MappingNode):
            return loader.construct_mapping(node, deep=True)
        return loader.construct_scalar(node)

    ComposeLoader.add_constructor("!override", untagged)
    ComposeLoader.add_constructor("!reset", untagged)
    return yaml.load(path.read_text(), Loader=ComposeLoader)


@pytest.mark.parametrize("path", ALL_COMPOSE, ids=lambda p: p.name)
def test_compose_file_exists_and_parses(path: Path):
    assert path.exists(), f"{path.name} is referenced by the docs and must exist"
    assert load(path).get("services"), f"{path.name} defines no services"


@pytest.mark.parametrize("path", ALL_COMPOSE + [ENV_TEMPLATE], ids=lambda p: p.name)
def test_no_absolute_home_paths(path: Path):
    """No deployment file may hardcode a path under someone's home directory."""
    offenders = [
        line.strip()
        for line in path.read_text().splitlines()
        if re.search(r"(?<![\w/])/(home|Users)/[A-Za-z0-9._-]+/", line)
        and not line.lstrip().startswith("#")
    ]
    assert offenders == [], f"{path.name} hardcodes a home directory: {offenders}"


def test_api_publishes_a_host_port():
    """`expose` is documentation; only `ports` makes the API reachable."""
    api = load(BASE)["services"]["api"]
    ports = api.get("ports")
    assert ports, "the API must publish a port, or no client can reach it"
    assert any("15597" in str(entry) for entry in ports)


def test_base_stack_needs_no_external_network():
    """An external network is one the operator must already have; nothing in
    this repository creates `central`, so requiring it broke every fresh
    install before it started."""
    for name, network in (load(BASE).get("networks") or {}).items():
        assert not (network or {}).get("external"), (
            f"network {name} is external in the base file; move it to an overlay"
        )


def test_only_two_compose_files():
    """Production and dev. Optional pieces are profiles, not more files."""
    found = sorted(p.name for p in BACKEND.glob("docker-compose*.yml"))
    assert found == ["docker-compose.dev.yml", "docker-compose.yml"], found


def test_nothing_started_by_default_reserves_a_gpu():
    """A device reservation makes `up` fail outright on a host with no NVIDIA
    runtime, so every service that asks for one must sit behind a profile."""
    for name, service in load(BASE)["services"].items():
        reservations = (
            (service.get("deploy") or {}).get("resources") or {}
        ).get("reservations") or {}
        if "devices" in reservations:
            assert service.get("profiles"), (
                f"{name} reserves a GPU and runs by default; put it behind a profile"
            )


def test_services_that_run_by_default_build_only_from_this_repository():
    """A profiled service may build from a checkout the operator supplies; one
    that starts by default may not."""
    for name, service in load(BASE)["services"].items():
        if service.get("profiles"):
            continue
        build = service.get("build")
        if not build:
            continue
        context = build["context"] if isinstance(build, dict) else build
        assert "${" not in str(context) and not str(context).startswith("/"), (
            f"{name} runs by default and builds from {context}"
        )


def test_api_waits_for_a_healthy_database():
    """`depends_on` alone only orders starts. The API needs Postgres ready."""
    depends = load(BASE)["services"]["api"]["depends_on"]
    assert isinstance(depends, dict), "use the long form with a condition"
    assert depends["postgres"]["condition"] == "service_healthy"


def test_database_declares_a_healthcheck():
    """...which means the database has to say when it is ready."""
    healthcheck = load(BASE)["services"]["postgres"].get("healthcheck")
    assert healthcheck, "postgres needs a healthcheck for service_healthy to mean anything"
    assert "pg_isready" in str(healthcheck["test"])


def test_base_api_depends_on_nothing_optional():
    """The speech services live in an overlay. A base-file `depends_on` naming
    one makes the whole project invalid whenever the overlay is absent."""
    depends = load(BASE)["services"]["api"]["depends_on"]
    assert set(depends) == {"postgres"}, (
        f"the API's base dependencies must be the database alone, got {sorted(depends)}"
    )


def test_speech_paths_have_no_real_default():
    """The speech services may interpolate VIXTTS_ROOT/UVOICE_ROOT, but the
    fallback must be an obvious placeholder — never a path that happens to
    exist on somebody's machine. (`:?` cannot be used: Compose interpolates
    every service, including ones a profile has switched off.)"""
    text = BASE.read_text()
    for variable in ("VIXTTS_ROOT", "UVOICE_ROOT"):
        defaults = re.findall(rf"\$\{{{variable}:-([^}}]*)\}}", text)
        assert defaults, f"{variable} must carry a placeholder default"
        for default in defaults:
            assert variable in default, (
                f"{variable}'s fallback is {default!r}; it must name the variable "
                "so the failure says what to set"
            )


def test_env_template_documents_every_variable_the_base_file_reads():
    """A variable the stack interpolates but the template never mentions is a
    setting nobody knows to set."""
    template = ENV_TEMPLATE.read_text()
    # Names the operator sets; POSTGRES_* and the rest are all in scope, but
    # variables Compose itself defines (none here) would not be.
    referenced = set(re.findall(r"\$\{([A-Z][A-Z0-9_]*)[:?}-]", BASE.read_text()))
    missing = sorted(
        name for name in referenced if not re.search(rf"^#?\s*{name}=", template, re.M)
    )
    assert missing == [], f"not in the environment template: {missing}"


def test_every_setting_the_server_reads_reaches_the_container():
    """A knob the operator can set has to arrive where it is read.

    `ALLOW_REGISTRATION`, `MCP_TLS_VERIFY` and the rate-limit pair were in the
    environment template and documented in two tables, and none of them were
    passed into the api service — so setting them did nothing at all.
    """
    source_files = [
        path
        for path in (BACKEND / "kurisuassistant").rglob("*.py")
        # Migrations pin their own history, and `core/mcp_tools/` is MCP servers
        # installed at runtime — third-party code whose own env reads are not
        # this deployment's business.
        if "alembic/versions" not in str(path)
        and "core/mcp_tools" not in str(path)
        and "node_modules" not in str(path)
    ]
    read_by_server = set()
    for path in source_files:
        read_by_server |= set(
            re.findall(r"os\.(?:getenv|environ\.get)\(\s*[\"']([A-Z][A-Z0-9_]*)[\"']", path.read_text())
        )
        read_by_server |= set(
            re.findall(r"API_KEY_ENV\s*=\s*[\"']([A-Z][A-Z0-9_]*)[\"']", path.read_text())
        )

    assert read_by_server, "found no environment reads; the pattern must have drifted"

    passed_in = {
        entry.split("=", 1)[0]
        for entry in load(BASE)["services"]["api"]["environment"]
    }
    missing = sorted(read_by_server - passed_in)
    assert missing == [], (
        f"the server reads {missing} but the api service never receives them"
    )


def test_entrypoint_bounds_its_wait_and_reports_why():
    """An unbounded silent retry loop makes a wrong password look like a slow
    start, for ever."""
    text = (BACKEND / "docker-entrypoint.sh").read_text()
    assert "2>/dev/null" not in text, "the connection error is the diagnosis; do not discard it"
    assert "DB_WAIT_ATTEMPTS" in text, "the wait must be bounded"


def test_the_entrypoint_decides_what_to_trust_and_says_so():
    """Behind a proxy, uvicorn's default (trust 127.0.0.1 only) made every
    request look like the proxy and gave the login limiter one bucket for
    everyone (#155). The list must come from the environment, be off when unset,
    and be printed so an operator can see what the server believes."""
    text = (BACKEND / "docker-entrypoint.sh").read_text()
    assert "FORWARDED_ALLOW_IPS" in text, "the trusted-proxy list must be configurable"
    assert "--no-proxy-headers" in text, "unset must mean the header is ignored, not trusted"
    assert "--forwarded-allow-ips" in text
    assert "Proxy headers:" in text, "the startup log must say what is trusted"


def test_the_bundled_proxy_documents_what_the_api_must_trust():
    """nginx sets the headers; they are inert unless the api trusts it."""
    text = (BACKEND / "nginx" / "nginx.conf").read_text()
    assert "X-Forwarded-For" in text
    assert "FORWARDED_ALLOW_IPS" in text, "say where the other half of the setting lives"


def test_dockerfile_copies_the_application_in():
    """The image is the artefact; it has to carry the code (#98)."""
    text = (BACKEND / "Dockerfile").read_text()
    assert "COPY kurisuassistant" in text
    assert "COPY scripts" in text


def test_the_api_mounts_state_and_never_source():
    """Only the dev overlay mounts source over the image's copy. (The speech
    services mount model directories from the operator's own checkouts; that is
    what those profiles are for.)"""
    for volume in load(BASE)["services"]["api"].get("volumes") or []:
        source = str(volume).split(":")[0]
        assert source == "./data", f"the API mounts {source}; it carries state only"
