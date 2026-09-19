"""Starting and stopping the engine containers, through a filtered Docker API.

The API must never hold the Docker socket: it sits behind a proxy on a machine
running other people's stacks, and the socket is root there. What it gets
instead is the address of a socket proxy configured to allow container inspect,
start and stop and nothing else — no exec, no image pulls, no volumes (#221).
Unset that address and residency management is simply off.

Only the containers named here are ever touched, and the names come from the
deployment's own configuration, so a mistake cannot reach a neighbour's stack.
"""

import logging
import os

import httpx

from kurisuassistant.core.http import get_client

logger = logging.getLogger(__name__)

#: How long to wait for a container to stop before the daemon kills it.
STOP_TIMEOUT = 20


class DockerUnavailable(RuntimeError):
    """The proxy is unset, unreachable, or refused what was asked."""


def proxy_url() -> str | None:
    """Where the filtered Docker API is, or ``None`` when there is none."""
    return (os.environ.get("SPEECH_DOCKER_URL", "").strip() or None)


def container_for(model_id: str) -> str | None:
    """The container that serves ``model_id``, from the deployment's settings.

    ``SPEECH_CONTAINERS`` is ``model=container`` pairs — the same model ids the
    clients already store, so nothing new has to be kept in step.
    """
    for pair in os.environ.get("SPEECH_CONTAINERS", "").split(","):
        name, _, container = pair.partition("=")
        if name.strip() == model_id and container.strip():
            return container.strip()
    return None


async def _call(method: str, path: str, **kwargs) -> httpx.Response:
    url = proxy_url()
    if not url:
        raise DockerUnavailable("SPEECH_DOCKER_URL is not set")
    try:
        response = await get_client().request(method, f"{url.rstrip('/')}{path}", **kwargs)
    except httpx.HTTPError as e:
        raise DockerUnavailable(f"the Docker proxy at {url} did not answer: {e}") from e
    if response.status_code >= 400 and response.status_code != 304:
        raise DockerUnavailable(f"{method} {path} -> {response.status_code}: {response.text[:200]}")
    return response


async def is_running(container: str) -> bool:
    response = await _call("GET", f"/containers/{container}/json", timeout=10)
    return bool(response.json().get("State", {}).get("Running"))


async def start(container: str) -> None:
    """Start it. Already running is success, not an error (Docker answers 304)."""
    await _call("POST", f"/containers/{container}/start", timeout=30)
    logger.info("residency: started %s", container)


async def stop(container: str) -> None:
    """Stop it, giving it ``STOP_TIMEOUT`` seconds to exit on its own."""
    await _call("POST", f"/containers/{container}/stop", params={"t": STOP_TIMEOUT},
                timeout=STOP_TIMEOUT + 15)
    logger.info("residency: stopped %s", container)
