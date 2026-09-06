"""The protocol manifest is the backend's definition, written down (#93).

Nineteen event names were defined once as a Python enum and then retyped by hand
in TypeScript and again in Kotlin, with nothing checking that the three agreed —
and they did not. `protocol/events.json` is generated from this package, and
each client has a test that fails when its own copy drifts from it. These are
the backend's half: the committed manifest is current, and every event declares
which way it travels.
"""

import json

import pytest

from kurisuassistant.version import WIRE_PROTOCOL
from kurisuassistant.websocket.events import (
    BINARY_EVENTS,
    CLIENT_TO_SERVER,
    SERVER_TO_CLIENT,
    EventType,
)
from scripts.generate_protocol import MANIFEST_PATH, build_manifest, render


@pytest.fixture(scope="module")
def committed() -> dict:
    if not MANIFEST_PATH.exists():
        pytest.fail(f"{MANIFEST_PATH} is missing; run `python -m scripts.generate_protocol`")
    return json.loads(MANIFEST_PATH.read_text())


class TestTheCommittedManifestIsCurrent:
    def test_it_matches_what_the_generator_produces(self, committed):
        """The failure this exists for: the enum changed and nobody regenerated."""
        assert committed == build_manifest(), (
            "protocol/events.json is stale — run `python -m scripts.generate_protocol` "
            "from backend/ and commit the result"
        )

    def test_it_is_byte_for_byte_what_the_generator_writes(self):
        assert MANIFEST_PATH.read_text() == render(), "formatting drifted; regenerate it"

    def test_it_carries_the_wire_protocol(self, committed):
        assert committed["wire_protocol"] == WIRE_PROTOCOL


class TestEveryEventIsAccountedFor:
    def test_each_one_travels_exactly_one_way(self):
        for event in EventType:
            directions = [event in CLIENT_TO_SERVER, event in SERVER_TO_CLIENT]
            assert sum(directions) == 1, f"{event.value} is in neither or both direction sets"

    def test_the_manifest_lists_the_whole_enum(self, committed):
        assert set(committed["events"]) == {e.value for e in EventType}

    def test_only_the_webcam_frame_is_binary(self, committed):
        binary = {name for name, e in committed["events"].items() if e["transport"] == "binary"}
        assert binary == {e.value for e in BINARY_EVENTS} == {"vision_frame"}


class TestTheGeneratorRefusesAnIncompleteProtocol:
    def test_an_event_with_no_direction_is_an_error(self, monkeypatch):
        """A new event added to the enum and nowhere else must not generate a
        manifest that quietly omits its direction."""
        import scripts.generate_protocol as gen

        monkeypatch.setattr(gen, "CLIENT_TO_SERVER", frozenset())
        with pytest.raises(SystemExit) as info:
            gen.build_manifest()
        assert "no direction" in str(info.value)

    def test_an_event_going_both_ways_is_an_error(self, monkeypatch):
        import scripts.generate_protocol as gen

        monkeypatch.setattr(gen, "SERVER_TO_CLIENT", frozenset(EventType))
        with pytest.raises(SystemExit) as info:
            gen.build_manifest()
        assert "both directions" in str(info.value)
