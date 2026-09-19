"""Pressure-based residency (#221): what holds the GPU and what gives it back.

No Docker and no GPU here. `containers` is the seam for the first and
`free_bytes` for the second, so every decision the manager makes is drivable
from a test: how much is free, what is running, and what it costs.
"""

from unittest.mock import AsyncMock, patch

import pytest

from kurisuassistant.speech.residency import MB, Residency


class FakeEngine:
    """An engine that is healthy once its container is 'running'."""

    def __init__(self, model_id, docker, healthy_after=0):
        self.model_id = model_id
        self._docker = docker
        self._healthy_after = healthy_after
        self.health_calls = 0

    async def healthy(self):
        self.health_calls += 1
        running = self._docker.running.get(self._docker.names[self.model_id], False)
        return {"ok": running and self.health_calls > self._healthy_after, "message": ""}


class FakeDocker:
    """Container state, and a record of what was started and stopped."""

    def __init__(self, names, running=None):
        self.names = names
        self.running = dict(running or {})
        self.started, self.stopped = [], []

    async def is_running(self, container):
        return self.running.get(container, False)

    async def start(self, container):
        self.running[container] = True
        self.started.append(container)

    async def stop(self, container):
        self.running[container] = False
        self.stopped.append(container)


@pytest.fixture
def docker(monkeypatch):
    names = {"vixtts": "c-vixtts", "gpt-sovits": "c-sovits", "base": "c-whisper"}
    fake = FakeDocker(names)
    monkeypatch.setenv("SPEECH_DOCKER_URL", "http://docker-proxy:2375")
    monkeypatch.setenv(
        "SPEECH_CONTAINERS", ",".join(f"{m}={c}" for m, c in names.items()),
    )
    monkeypatch.setenv("SPEECH_VRAM_HEADROOM_MB", "0")
    monkeypatch.setenv("SPEECH_DEFAULT_FOOTPRINT_MB", "2000")
    monkeypatch.setattr("kurisuassistant.speech.residency.containers.is_running", fake.is_running)
    monkeypatch.setattr("kurisuassistant.speech.residency.containers.start", fake.start)
    monkeypatch.setattr("kurisuassistant.speech.residency.containers.stop", fake.stop)
    return fake


def gpu(*readings):
    """Free-VRAM readings in MB, returned in turn; the last one repeats.

    A start reads twice — once before, to decide, and once after the request,
    to measure — plus once more after each eviction.
    """
    values = [int(mb * MB) for mb in readings]
    def reading():
        return values[0] if len(values) == 1 else values.pop(0)
    return patch("kurisuassistant.speech.residency.free_bytes", side_effect=reading)


@pytest.mark.asyncio
class TestServing:
    async def test_a_running_engine_is_left_alone(self, docker):
        docker.running["c-vixtts"] = True
        manager = Residency()
        engine = FakeEngine("vixtts", docker)

        with gpu(8000):
            async with manager.serving(engine):
                pass

        assert docker.started == [] and docker.stopped == []

    async def test_a_stopped_engine_is_started_and_waited_for(self, docker):
        manager = Residency()
        engine = FakeEngine("vixtts", docker)

        with gpu(8000, 5500):
            async with manager.serving(engine):
                pass

        assert docker.started == ["c-vixtts"]
        assert engine.health_calls >= 1

    async def test_the_footprint_is_measured_not_configured(self, docker):
        """Free memory before the start, and again once the request has made
        the engine load its models; the difference is what it holds."""
        manager = Residency()
        engine = FakeEngine("vixtts", docker)

        with gpu(8000, 5800):
            async with manager.serving(engine):
                pass

        assert manager.status()["engines"]["vixtts"]["holds_mb"] == pytest.approx(2200, abs=1)

    async def test_a_reading_that_went_up_is_not_believed(self, docker):
        """Something else freeing memory must not be recorded as this engine
        costing nothing."""
        manager = Residency()
        engine = FakeEngine("vixtts", docker)

        with gpu(4000, 9000):
            async with manager.serving(engine):
                pass

        assert manager.status()["engines"]["vixtts"]["holds_mb"] is None


@pytest.mark.asyncio
class TestPressure:
    async def _warm(self, manager, docker, model, held_mb, free_after):
        """Bring an engine up and let it be measured at ``held_mb``."""
        engine = FakeEngine(model, docker)
        with gpu(free_after + held_mb, free_after):
            async with manager.serving(engine):
                pass
        assert manager.status()["engines"][model]["holds_mb"] == pytest.approx(held_mb, abs=1)
        return engine

    async def test_nothing_is_evicted_while_the_card_has_room(self, docker):
        manager = Residency()
        await self._warm(manager, docker, "vixtts", 2000, 6000)
        docker.stopped.clear()

        engine = FakeEngine("gpt-sovits", docker)
        with gpu(6000):
            async with manager.serving(engine):
                pass

        assert docker.stopped == []
        assert docker.started == ["c-vixtts", "c-sovits"]

    async def test_the_least_recently_used_engine_is_evicted_under_pressure(self, docker):
        manager = Residency()
        await self._warm(manager, docker, "vixtts", 2000, 6000)
        await self._warm(manager, docker, "base", 1000, 5000)
        docker.stopped.clear()

        # 500MB free, and the incoming engine has never been measured, so it is
        # assumed to want the configured 2000MB.
        engine = FakeEngine("gpt-sovits", docker)
        with gpu(500, 2500, 3500, 3500):
            async with manager.serving(engine):
                pass

        assert docker.stopped[0] == "c-vixtts", "the oldest use goes first"
        assert "c-sovits" in docker.started

    async def test_an_engine_in_use_is_never_evicted(self, docker):
        manager = Residency()
        await self._warm(manager, docker, "vixtts", 2000, 6000)
        docker.stopped.clear()
        held = FakeEngine("vixtts", docker)
        incoming = FakeEngine("gpt-sovits", docker)

        with gpu(200):
            async with manager.serving(held):
                async with manager.serving(incoming):
                    pass

        assert docker.stopped == [], "the only candidate was serving a request"
        assert "c-sovits" in docker.started, "the start is attempted anyway"

    async def test_an_unmeasured_engine_is_not_evicted(self, docker):
        """Stopping something whose cost is unknown might free nothing and
        still cost a cold start, so only measured engines are candidates."""
        manager = Residency()
        docker.running["c-vixtts"] = True
        with gpu(8000):
            async with manager.serving(FakeEngine("vixtts", docker)):
                pass
        docker.stopped.clear()

        with gpu(100, 100, 100, 100):
            async with manager.serving(FakeEngine("gpt-sovits", docker)):
                pass

        assert docker.stopped == []


@pytest.mark.asyncio
class TestNotConfigured:
    async def test_without_a_proxy_it_is_a_passthrough(self, docker, monkeypatch):
        monkeypatch.delenv("SPEECH_DOCKER_URL", raising=False)
        manager = Residency()

        with gpu(100):
            async with manager.serving(FakeEngine("vixtts", docker)):
                pass

        assert docker.started == [] and docker.stopped == []
        assert manager.status()["engines"] == {}

    async def test_an_engine_with_no_container_named_is_a_passthrough(self, docker, monkeypatch):
        monkeypatch.setenv("SPEECH_CONTAINERS", "vixtts=c-vixtts")
        manager = Residency()

        with gpu(100):
            async with manager.serving(FakeEngine("gpt-sovits", docker)):
                pass

        assert docker.started == []

    async def test_no_readable_gpu_still_starts_the_engine(self, docker):
        """A deployment whose API cannot see the card gets container management
        without pressure decisions, rather than nothing at all."""
        manager = Residency()
        engine = FakeEngine("vixtts", docker)

        with patch("kurisuassistant.speech.residency.free_bytes", return_value=None):
            async with manager.serving(engine):
                pass

        assert docker.started == ["c-vixtts"]
        assert manager.status()["gpu_free_mb"] is None


@pytest.mark.asyncio
class TestFailures:
    async def test_an_engine_that_never_answers_is_the_outage_sentence(self, docker, monkeypatch):
        from fastapi import HTTPException

        monkeypatch.setenv("SPEECH_START_TIMEOUT_SECONDS", "0.2")
        manager = Residency()
        engine = FakeEngine("vixtts", docker, healthy_after=10_000)

        with gpu(8000), pytest.raises(HTTPException) as caught:
            async with manager.serving(engine):
                pass

        assert caught.value.status_code == 502
        assert "unavailable" in caught.value.detail

    async def test_an_unreachable_proxy_leaves_engines_alone(self, docker, monkeypatch):
        """The proxy is the optional half: losing it must not take speech down
        for a deployment whose engines are already running."""
        from kurisuassistant.speech import containers as containers_module

        monkeypatch.setattr(
            "kurisuassistant.speech.residency.containers.is_running",
            AsyncMock(side_effect=containers_module.DockerUnavailable("no route")),
        )
        manager = Residency()

        with gpu(8000):
            async with manager.serving(FakeEngine("vixtts", docker)):
                pass

        assert docker.started == []
