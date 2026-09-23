"""What a saved ``character_config`` may delete, and which names a request may use.

Regression cover for #233. Saving a config used to sweep the persona's asset
directory *before* the row was written and to treat any config it did not
understand — a shape without ``pose_tree``, a pose tree pointing at another
persona's ids — as referencing nothing, which emptied the directory. The
persona route wrote the same column and swept nothing. And every id and file
name in the router was joined onto a disk path as sent.

#235 then made ``kind`` required and a save a merge per member; those cases are
``TestKindAndMembers`` and ``TestReferencedPaths``.

The store is pointed at ``tmp_path`` through the one name every module reads at
call time, ``kurisuassistant.character.paths.CHAR_ASSETS_DIR``; the database is
a stub repository, because none of this is about SQL.
"""

import io
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.character import paths
from kurisuassistant.character.references import Classification, classify, referenced_paths
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import character, personas

PERSONA = 1
OTHER = 2

# Files a persona owns before each test: two poses (only ``p1`` is referenced by
# the config below), one edge video, and an upload still streaming in.
SEED = ["p1/base.png", "p1/mouth_0.png", "p2/base.png", "edges/e1.mp4", ".incoming/part"]
INCOMING_ONLY = {".incoming/part"}


def pose_tree(persona_id=PERSONA, **extra):
    """A pose-graph config that references ``p1/base``, ``p1/mouth_0`` and ``edges/e1``."""
    prefix = f"/character-assets/{persona_id}"
    return {
        "kind": "pose_graph",
        **extra,
        "pose_tree": {
            "default_pose_ids": ["p1"],
            "nodes": [
                {
                    "id": "p1", "name": "p1", "type": "pose",
                    "position": {"x": 0, "y": 0},
                    "pose_config": {
                        "name": "p1",
                        "base_image_url": f"{prefix}/p1/base",
                        "left_eye": {"patches": []},
                        "right_eye": {"patches": []},
                        "mouth": {"patches": [
                            {"image_url": f"{prefix}/p1/mouth_0", "x": 0, "y": 0, "width": 1, "height": 1},
                        ]},
                    },
                },
            ],
            "edges": [
                {
                    "id": "p1-p1", "from_node_id": "p1", "to_node_id": "p1",
                    "transitions": [{"conditions": [], "video_urls": [f"{prefix}/edges/e1"]}],
                },
            ],
        },
    }


EMPTY_GRAPH = {"kind": "pose_graph", "pose_tree": {"default_pose_ids": [], "nodes": [], "edges": []}}


class FakePersona:
    def __init__(self, persona_id, user_id):
        self.id = persona_id
        self.user_id = user_id
        self.name = f"persona-{persona_id}"
        self.description = ""
        self.system_prompt = ""
        self.preferred_name = None
        self.voice_reference = None
        self.avatar_uuid = None
        self.character_config = EMPTY_GRAPH
        self.enabled = True


class FakePersonaRepository:
    """One persona, id 1, owned by user 1. ``fail_writes`` makes every write raise."""

    persona = None
    fail_writes = False

    def __init__(self, session):
        pass

    def get_by_user_and_id(self, user_id, persona_id):
        p = FakePersonaRepository.persona
        return p if p and p.user_id == user_id and p.id == persona_id else None

    def get_by_user_and_name(self, user_id, name):
        return None

    def list_by_user(self, user_id):
        return [FakePersonaRepository.persona]

    def update_persona(self, persona, **fields):
        if FakePersonaRepository.fail_writes:
            raise RuntimeError("database down")
        for key, value in fields.items():
            setattr(persona, key, value)
        return persona

    def create_persona(self, user_id, name, **fields):
        created = FakePersona(7, user_id)
        created.name = name
        for key, value in fields.items():
            setattr(created, key, value)
        return created


class FakeDBService:
    async def execute(self, operation, timeout=None):
        return operation(None)


class Store:
    def __init__(self, root, client):
        self.root = root
        self.client = client

    def seed(self):
        for rel in SEED:
            path = self.root / str(PERSONA) / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")

    def files(self):
        persona_dir = self.root / str(PERSONA)
        if not persona_dir.exists():
            return set()
        return {p.relative_to(persona_dir).as_posix() for p in persona_dir.rglob("*") if p.is_file()}

    @property
    def persona(self):
        return FakePersonaRepository.persona


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "CHAR_ASSETS_DIR", tmp_path)
    # The router used to keep its own copy of the constant; when these tests are
    # run against that code to show them failing, this keeps it off the real data/.
    monkeypatch.setattr(character, "CHAR_ASSETS_DIR", tmp_path, raising=False)

    FakePersonaRepository.persona = FakePersona(PERSONA, 1)
    FakePersonaRepository.fail_writes = False
    for module in (character, personas):
        monkeypatch.setattr(module, "PersonaRepository", FakePersonaRepository)
        monkeypatch.setattr(module, "get_db_service", lambda: FakeDBService())
    monkeypatch.setattr(personas, "_adopt_as_default_if_unset", lambda *a, **k: None)

    app = FastAPI()
    app.dependency_overrides[get_authenticated_user] = lambda: type("U", (), {"id": 1, "username": "t"})()
    app.include_router(character.router)
    app.include_router(personas.router)

    s = Store(tmp_path, TestClient(app, raise_server_exceptions=False))
    s.seed()
    return s


def via_character(client, config):
    return client.patch(f"/character-assets/{PERSONA}/character-config", json=config)


def via_persona(client, config):
    return client.patch(f"/personas/{PERSONA}", json={"character_config": config})


WRITERS = pytest.mark.parametrize("write", [via_character, via_persona], ids=["character-config", "personas"])


# Shapes the walker must refuse rather than read as "references nothing". The
# first four were coerced into an empty tree (``or {}`` / ``or []``) and emptied
# the directory with a 200; the rest raised inside the walk and answered 500.
# Without a ``kind`` every one of these is now refused by the schema before the
# walker sees it (#235); ``MALFORMED_MEMBERS`` below sends the same shapes with a
# kind so the walker's own strictness stays under test.
UNCLASSIFIABLE = [
    pytest.param({"poses": []}, id="no-pose_tree"),
    pytest.param({"pose_tree": None}, id="pose_tree-null"),
    pytest.param({"pose_tree": []}, id="pose_tree-list"),
    pytest.param({"pose_tree": ""}, id="pose_tree-string"),
    pytest.param({"pose_tree": {"nodes": [None]}}, id="node-null"),
    pytest.param({"pose_tree": {"nodes": {"a": 1}}}, id="nodes-dict"),
    pytest.param({"pose_tree": {"nodes": [{"pose_config": "x"}]}}, id="pose_config-string"),
    pytest.param({"pose_tree": {"nodes": [{"pose_config": {"mouth": []}}]}}, id="part-list"),
    pytest.param({"pose_tree": {"nodes": [{"pose_config": {"mouth": {"patches": ["x"]}}}]}}, id="patch-string"),
    pytest.param({"pose_tree": {"edges": [{"transitions": "x"}]}}, id="transitions-string"),
    pytest.param({"pose_tree": {"edges": [{"transitions": [{"video_urls": [1]}]}]}}, id="video_url-number"),
    pytest.param({"pose_tree": {"edges": ["e1"]}}, id="edge-string"),
]

# The same loose shapes inside a kinded body. Two layers refuse them, and both
# must answer 422 with nothing unlinked. The schema stops a ``pose_tree`` that is
# not an object or null (the list and string cases) and a ``vrm`` whose
# ``model``/``clips`` are not the full ``VrmAssetRef``/``VrmClipRef`` shape (the
# two VRM cases: an int ``url`` and the missing ``sha256``/``bytes`` fields die in
# pydantic, before the walker). Everything *inside* a pose tree is the walker's
# to refuse — a node, part, patch or transition of the wrong type, or a video
# URL that is not a string. The walker's own VRM strictness is exercised
# directly in ``TestReferencedPaths``, because the write path replaces a body's
# ``model``/``clips`` with the stored values before the walk ever sees them.
MALFORMED_MEMBERS = [
    pytest.param({"kind": "pose_graph", "pose_tree": []}, id="kinded-pose_tree-list"),
    pytest.param({"kind": "pose_graph", "pose_tree": ""}, id="kinded-pose_tree-string"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"nodes": [None]}}, id="kinded-node-null"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"nodes": {"a": 1}}}, id="kinded-nodes-dict"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"nodes": [{"pose_config": "x"}]}}, id="kinded-pose_config-string"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"nodes": [{"pose_config": {"mouth": []}}]}}, id="kinded-part-list"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"nodes": [{"pose_config": {"mouth": {"patches": ["x"]}}}]}}, id="kinded-patch-string"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"edges": [{"transitions": "x"}]}}, id="kinded-transitions-string"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"edges": [{"transitions": [{"video_urls": [1]}]}]}}, id="kinded-video_url-number"),
    pytest.param({"kind": "pose_graph", "pose_tree": {"edges": ["e1"]}}, id="kinded-edge-string"),
    pytest.param({"kind": "vrm", "vrm": {"model": {"url": 1}}}, id="kinded-model-url-number"),
    pytest.param({"kind": "vrm", "vrm": {"clips": [{"url": 1}]}}, id="kinded-clip-url-number"),
]


class TestWhatASaveMayDelete:
    @WRITERS
    @pytest.mark.parametrize("config", UNCLASSIFIABLE + MALFORMED_MEMBERS)
    def test_a_config_that_cannot_be_classified_is_refused_and_nothing_is_unlinked(self, store, write, config):
        before = store.files()
        response = write(store.client, config)
        assert response.status_code == 422
        assert store.files() == before
        assert store.persona.character_config == EMPTY_GRAPH

    @WRITERS
    def test_the_detail_names_the_member_and_the_cause(self, store, write):
        """A malformed member and a foreign URL are different mistakes; the client is told which."""
        shape = write(store.client, {"kind": "pose_graph", "pose_tree": {"nodes": [{"pose_config": {"mouth": []}}]}})
        assert shape.status_code == 422
        assert shape.json()["detail"] == "character_config.pose_tree is not the shape the clients write."
        foreign = write(store.client, pose_tree(OTHER))
        assert foreign.status_code == 422
        assert foreign.json()["detail"] == "character_config.pose_tree names another persona's assets."

    @WRITERS
    def test_a_stored_member_the_body_never_sent_is_named_when_it_is_refused(self, store, write):
        """The member at fault may be one already in the row: the detail says so, so it can be cleared."""
        store.persona.character_config = {"kind": "vrm", "vrm": {"model": "x", "clips": []}}
        before = store.files()
        response = write(store.client, {"kind": "vrm", "vrm": {}})
        assert response.status_code == 422
        assert response.json()["detail"] == "character_config.vrm is not the shape the clients write."
        assert store.files() == before
        cleared = write(store.client, {"kind": "vrm", "vrm": None})
        assert cleared.status_code == 200
        assert store.persona.character_config == {"kind": "vrm"}

    @WRITERS
    def test_a_well_formed_tree_that_references_nothing_keeps_nothing(self, store, write):
        """The empty set is a real answer — but only from a shape the walker recognised."""
        response = write(store.client, EMPTY_GRAPH)
        assert response.status_code == 200
        assert store.files() == INCOMING_ONLY

    @WRITERS
    def test_a_null_member_is_a_clear_not_a_loose_shape(self, store, write):
        """``pose_tree: null`` with a kind clears that member on purpose (#235); without a kind it is 422."""
        response = write(store.client, {"kind": "pose_graph", "pose_tree": None})
        assert response.status_code == 200
        assert store.persona.character_config == {"kind": "pose_graph"}
        assert store.files() == INCOMING_ONLY

    def test_a_patch_that_does_not_mention_the_config_touches_nothing(self, store):
        """A rename must never be a sweep: the persona route only plans when the field is sent."""
        before = store.files()
        response = store.client.patch(f"/personas/{PERSONA}", json={"name": "renamed"})
        assert response.status_code == 200
        assert store.persona.name == "renamed"
        assert store.files() == before

    @WRITERS
    def test_a_pose_tree_keeps_what_it_names_and_removes_the_rest(self, store, write):
        response = write(store.client, pose_tree())
        assert response.status_code == 200
        assert store.files() == {"p1/base.png", "p1/mouth_0.png", "edges/e1.mp4", ".incoming/part"}
        assert not (store.root / str(PERSONA) / "p2").exists()

    @WRITERS
    def test_a_pose_tree_pointing_at_another_persona_is_refused_and_nothing_is_unlinked(self, store, write):
        before = store.files()
        response = write(store.client, pose_tree(OTHER))
        assert response.status_code == 422
        assert store.files() == before

    @WRITERS
    def test_a_failed_write_leaves_every_file_in_place(self, store, write):
        FakePersonaRepository.fail_writes = True
        before = store.files()
        response = write(store.client, pose_tree())
        assert response.status_code == 500
        assert store.files() == before

    def test_clearing_the_config_removes_everything_but_the_upload_in_flight(self, store):
        response = via_persona(store.client, None)
        assert response.status_code == 200
        assert store.persona.character_config is None
        assert store.files() == INCOMING_ONLY

    def test_a_new_persona_may_not_claim_assets(self, store):
        refused = store.client.post("/personas", json={"name": "new", "character_config": pose_tree()})
        assert refused.status_code == 422
        created = store.client.post("/personas", json={"name": "new", "character_config": None})
        assert created.status_code == 200


class TestTheSweepNeverFailsTheSave:
    """Once the row is committed the response is a success whatever the disk does."""

    def test_a_file_removed_underneath_the_sweep_is_not_an_error(self, store, monkeypatch):
        # A second save (or the operator) took ``p2/base.png`` between the walk
        # listing it and the unlink; the old sweep let that become a 500.
        original = Path.unlink
        raised = []

        def vanish(self, *args, **kwargs):
            if self.name == "base.png" and self.parent.name == "p2" and not raised:
                raised.append(self)
                raise FileNotFoundError(self)
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", vanish)
        response = via_character(store.client, pose_tree())
        assert response.status_code == 200
        assert raised, "the race was never exercised"
        assert "p1/base.png" in store.files()

    def test_a_symlink_inside_the_persona_dir_is_left_alone(self, store, tmp_path):
        outside = tmp_path / "elsewhere"
        outside.mkdir()
        (outside / "keep.png").write_bytes(b"x")
        empty = tmp_path / "empty-elsewhere"
        empty.mkdir()
        persona_dir = store.root / str(PERSONA)
        os.symlink(outside, persona_dir / "linked")
        os.symlink(empty, persona_dir / "linked-empty")
        os.symlink(outside / "keep.png", persona_dir / "p2" / "linked.png")

        response = via_character(store.client, pose_tree())
        assert response.status_code == 200
        assert (outside / "keep.png").exists()
        assert empty.exists()
        assert (persona_dir / "linked").is_symlink()
        assert (persona_dir / "linked-empty").is_symlink()
        assert (persona_dir / "p2" / "linked.png").is_symlink()
        assert not (persona_dir / "p2" / "base.png").exists()


VRM_MODEL = {
    "url": f"/character-assets/{PERSONA}/vrm/model",
    "sha256": "a" * 64,
    "bytes": 3,
    "uploaded_at": "2026-09-20T00:00:00Z",
}
# The model is stored content-addressed (#236): its file is named by its sha.
MODEL_FILE = f"{'a' * 64}.vrm"
VRM_CLIP = {
    "id": "deadbeef",
    "name": "wave",
    "url": f"/character-assets/{PERSONA}/vrma/deadbeef",
    "sha256": "b" * 64,
    "bytes": 3,
    "loop": False,
}


def vrm_settings(**overrides):
    """A stored VRM member with a model and one clip, both server-owned refs."""
    return {"model": VRM_MODEL, "clips": [VRM_CLIP], **overrides}


def both_kinds():
    """A persona holding both systems: the pose graph above plus a VRM model and clip."""
    return {**pose_tree(), "vrm": vrm_settings()}


class TestKindAndMembers:
    """``kind`` is required and selects; the two members are merged, never replaced (#235)."""

    @WRITERS
    def test_a_body_without_kind_is_refused_and_nothing_is_unlinked(self, store, write):
        legacy = {k: v for k, v in pose_tree().items() if k != "kind"}
        before = store.files()
        response = write(store.client, legacy)
        assert response.status_code == 422
        assert store.files() == before
        assert store.persona.character_config == EMPTY_GRAPH

    @pytest.mark.parametrize("body", [{}, {"foo": 1}, {"kind": "hologram"}, {"kind": "vrm", "vrm": {"foo": 1}}])
    def test_a_shape_the_schema_rejects_is_refused(self, store, body):
        before = store.files()
        response = via_character(store.client, body)
        assert response.status_code == 422
        assert store.files() == before

    @WRITERS
    def test_a_member_left_out_is_kept(self, store, write):
        store.persona.character_config = pose_tree()
        response = write(store.client, {"kind": "vrm"})
        assert response.status_code == 200
        assert store.persona.character_config == {**pose_tree(), "kind": "vrm"}
        # The pose art is still referenced, so the sweep keeps it.
        assert store.files() == {"p1/base.png", "p1/mouth_0.png", "edges/e1.mp4", ".incoming/part"}

    def test_a_kind_flip_keeps_every_file_either_member_references(self, store):
        """A kind-only body still sweeps — it removes the seed's one orphan and nothing else."""
        store.persona.character_config = both_kinds()
        (store.root / str(PERSONA) / "vrm").mkdir()
        (store.root / str(PERSONA) / "vrm" / MODEL_FILE).write_bytes(b"glb")
        referenced = store.files() - {"p2/base.png"}
        for kind in ("vrm", "pose_graph", "vrm"):
            assert via_character(store.client, {"kind": kind}).status_code == 200
            assert store.files() == referenced
            assert store.persona.character_config == {**both_kinds(), "kind": kind}

    def test_clearing_one_member_removes_its_files_and_keeps_the_other(self, store):
        store.persona.character_config = both_kinds()
        (store.root / str(PERSONA) / "vrm").mkdir()
        (store.root / str(PERSONA) / "vrm" / MODEL_FILE).write_bytes(b"glb")
        response = via_character(store.client, {"kind": "vrm", "pose_tree": None})
        assert response.status_code == 200
        assert store.persona.character_config == {"kind": "vrm", "vrm": vrm_settings()}
        assert store.files() == {f"vrm/{MODEL_FILE}", ".incoming/part"}

    def test_the_response_carries_the_merged_config(self, store):
        store.persona.character_config = pose_tree()
        response = via_character(store.client, {"kind": "vrm", "vrm": {}})
        assert response.status_code == 200
        merged = response.json()["character_config"]
        assert merged["kind"] == "vrm"
        assert merged["pose_tree"] == pose_tree()["pose_tree"]
        assert merged["vrm"]["model"] is None and merged["vrm"]["clips"] == []

    def test_a_vrm_body_is_normalised_with_defaults(self, store):
        response = via_character(store.client, {"kind": "vrm", "vrm": {}})
        assert response.status_code == 200
        vrm = store.persona.character_config["vrm"]
        assert vrm["idle"]["breath_period_ms"] == 4000
        assert vrm["idle"]["blink"]["blink_min_interval"] == 2000
        assert vrm["emotion"]["default_expression"] == "neutral"
        assert vrm["camera"]["target"] == "upper_body"
        assert vrm["reactions"] == []

    @WRITERS
    def test_server_owned_refs_in_a_body_are_ignored(self, store, write):
        store.persona.character_config = {"kind": "vrm", "vrm": vrm_settings()}
        foreign = {"url": f"/character-assets/{OTHER}/vrm/model", "sha256": "c" * 64, "bytes": 1, "uploaded_at": "x"}
        response = write(store.client, {"kind": "vrm", "vrm": {"model": foreign, "clips": []}})
        assert response.status_code == 200
        stored = store.persona.character_config["vrm"]
        assert stored["model"] == VRM_MODEL and stored["clips"] == [VRM_CLIP]
        # And a body that tries to un-reference the model cannot: a stale autosave
        # from any writer leaves the file the server accepted alone.
        assert write(store.client, {"kind": "vrm", "vrm": {"model": None}}).status_code == 200
        assert store.persona.character_config["vrm"]["model"] == VRM_MODEL

    def test_a_clip_id_the_store_does_not_hold_is_refused(self, store):
        body = {"kind": "vrm", "vrm": {"idle": {"idle_clip_ids": ["deadbeef"]}}}
        assert via_character(store.client, body).status_code == 422
        store.persona.character_config = {"kind": "vrm", "vrm": vrm_settings()}
        assert via_character(store.client, body).status_code == 200
        assert store.persona.character_config["vrm"]["idle"]["idle_clip_ids"] == ["deadbeef"]
        reaction = {"id": "0badf00d", "when": [{"type": "thinking", "value": True}],
                    "play": {"type": "clip", "clip_id": "c0ffee00"}}
        assert via_character(store.client, {"kind": "vrm", "vrm": {"reactions": [reaction]}}).status_code == 422

    def test_a_new_persona_takes_a_config_that_names_no_file(self, store):
        created = store.client.post(
            "/personas", json={"name": "new", "character_config": {"kind": "vrm", "vrm": {"model": None, "clips": []}}}
        )
        assert created.status_code == 200
        assert created.json()["character_config"]["kind"] == "vrm"
        assert created.json()["character_config"]["vrm"]["camera"]["fov"] == 24
        treeless = store.client.post(
            "/personas", json={"name": "new", "character_config": {"kind": "pose_graph"}}
        )
        assert treeless.status_code == 200, "a pose_graph kind with no tree names no file"

    @pytest.mark.parametrize("interval, status", [
        ([1000, 5000], 200), ([5000, 5000], 200), ([5000, 1000], 422), ([-1, 5000], 422), ([1000], 422),
    ])
    def test_the_idle_clip_interval_is_a_bounded_range(self, store, interval, status):
        body = {"kind": "vrm", "vrm": {"idle": {"idle_clip_interval_ms": interval}}}
        assert via_character(store.client, body).status_code == status


class TestReferencedPaths:
    """The walker reads both members whatever ``kind`` says, and refuses what it cannot place."""

    def test_both_members_are_collected(self):
        refs = referenced_paths(PERSONA, both_kinds())
        assert refs == {f"{PERSONA}/p1/base", f"{PERSONA}/p1/mouth_0", f"{PERSONA}/edges/e1",
                        f"{PERSONA}/vrm/{'a' * 64}", f"{PERSONA}/vrma/deadbeef"}

    def test_the_selected_kind_does_not_narrow_the_walk(self):
        assert referenced_paths(PERSONA, {**both_kinds(), "kind": "vrm"}) == referenced_paths(PERSONA, both_kinds())

    @pytest.mark.parametrize("config", [
        {"pose_tree": {"nodes": []}},                       # no kind
        {"kind": "hologram", "pose_tree": {"nodes": []}},
        {"kind": "pose_graph", "pose_tree": "not an object"},
        {"kind": "vrm", "vrm": "not an object"},
        {"kind": "vrm", "vrm": {"model": {"url": f"/character-assets/{OTHER}/vrm/model"}}},
        {"kind": "vrm", "vrm": {"clips": [{"url": f"/character-assets/{OTHER}/vrma/x"}]}},
        # The VRM member's own shape rules — only reachable here, because the
        # write path swaps a body's model/clips for the stored ones first.
        {"kind": "vrm", "vrm": {"model": "x"}},
        {"kind": "vrm", "vrm": {"model": {"url": 1}}},
        {"kind": "vrm", "vrm": {"model": {}}},
        # A model ref names its file by its sha; without a well-formed one there is no file to keep.
        {"kind": "vrm", "vrm": {"model": {"url": f"/character-assets/{PERSONA}/vrm/model"}}},
        {"kind": "vrm", "vrm": {"model": {"url": f"/character-assets/{PERSONA}/vrm/model", "sha256": "../../x"}}},
        {"kind": "vrm", "vrm": {"clips": "x"}},
        {"kind": "vrm", "vrm": {"clips": [1]}},
        {"kind": "vrm", "vrm": {"clips": [{"url": 1}]}},
    ])
    def test_what_it_cannot_place_is_none(self, config):
        assert referenced_paths(PERSONA, config) is None

    @pytest.mark.parametrize("config, refusal", [
        ("x", "character_config must be an object."),
        ({"pose_tree": {}}, 'character_config.kind must be "pose_graph" or "vrm".'),
        ({"kind": "vrm", "vrm": {"clips": [1]}}, "character_config.vrm is not the shape the clients write."),
        ({"kind": "vrm", "vrm": {"clips": [{"url": f"/character-assets/{OTHER}/vrma/x"}]}},
         "character_config.vrm names another persona's assets."),
        ({"kind": "pose_graph", "pose_tree": {"edges": ["e1"]}},
         "character_config.pose_tree is not the shape the clients write."),
    ])
    def test_a_refusal_says_which_member_and_why(self, config, refusal):
        assert classify(PERSONA, config) == Classification(None, refusal)

    def test_a_replaced_model_file_is_swept_and_the_current_one_kept(self, store):
        """Content-addressed: the file the ref's sha names is kept, any other ``vrm/*.vrm`` goes."""
        store.persona.character_config = {"kind": "vrm", "vrm": vrm_settings()}
        vrm_dir = store.root / str(PERSONA) / "vrm"
        vrm_dir.mkdir()
        (vrm_dir / MODEL_FILE).write_bytes(b"current")
        (vrm_dir / f"{'f' * 64}.vrm").write_bytes(b"replaced")
        assert via_character(store.client, {"kind": "vrm"}).status_code == 200
        assert f"vrm/{MODEL_FILE}" in store.files()
        assert f"vrm/{'f' * 64}.vrm" not in store.files()

    def test_a_classification_that_succeeds_carries_no_refusal(self):
        assert classify(PERSONA, {"kind": "vrm"}) == Classification(set(), None)

    def test_a_config_with_no_members_references_nothing(self):
        assert referenced_paths(PERSONA, {"kind": "vrm"}) == set()


BAD_SEGMENTS = ["vrm", "vrma", "edges", ".incoming", "..", "%2e%2e", "a%2Fb", "a%5Cb"]
# In a *path* a raw ``..`` is resolved by the client and an encoded slash splits the
# segment before routing, so neither reaches a handler; ``%2e%2e`` does, as ``..``.
SERVING_BAD = [b for b in BAD_SEGMENTS if b not in ("..", "a%2Fb")]


class TestPathSegments:
    """Every name a request supplies is joined onto a disk path; none may leave it."""

    @pytest.mark.parametrize("bad", BAD_SEGMENTS + [""])
    def test_upload_base_refuses_a_bad_pose_id(self, store, bad):
        response = store.client.post(
            f"/character-assets/upload-base?persona_id={PERSONA}&pose_id={bad}",
            files={"file": ("k.png", io.BytesIO(b"x"), "image/png")},
        )
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid pose_id.")

    @pytest.mark.parametrize("bad", BAD_SEGMENTS + [""])
    def test_compute_patch_refuses_a_bad_pose_id(self, store, bad):
        # ``safe_segment`` runs before the base image is read, so no image is needed.
        response = store.client.post(
            f"/character-assets/compute-patch?persona_id={PERSONA}&pose_id={bad}&part=mouth&index=0",
            files={"keyframe": ("k.png", io.BytesIO(b"x"), "image/png")},
        )
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid pose_id.")

    @pytest.mark.parametrize("bad", BAD_SEGMENTS + [""])
    def test_upload_video_refuses_a_bad_edge_id(self, store, bad):
        response = store.client.post(
            f"/character-assets/upload-video?persona_id={PERSONA}&edge_id={bad}",
            files={"file": ("v.mp4", io.BytesIO(b"x"), "video/mp4")},
        )
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid edge_id.")

    # ``edges`` and ``vrma`` as a pose id reach their own routes first, which refuse
    # ``base`` as an edge or clip id; that is covered with those routes.
    @pytest.mark.parametrize("bad", [b for b in SERVING_BAD if b not in ("edges", "vrma")])
    def test_serving_a_pose_refuses_a_bad_pose_id(self, store, bad):
        response = store.client.get(f"/character-assets/{PERSONA}/{bad}/base")
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid pose_id.")

    @pytest.mark.parametrize("bad", SERVING_BAD)
    def test_serving_a_pose_refuses_a_bad_filename(self, store, bad):
        response = store.client.get(f"/character-assets/{PERSONA}/p1/{bad}")
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid filename.")

    @pytest.mark.parametrize("bad", SERVING_BAD)
    def test_serving_an_edge_refuses_a_bad_edge_id(self, store, bad):
        response = store.client.get(f"/character-assets/{PERSONA}/edges/{bad}")
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid edge_id.")

    @pytest.mark.parametrize("mapping", [{"..": "p9"}, {"p1": "../p9"}, {"edges": "p9"}, {"p1": ""}])
    def test_migrate_ids_refuses_a_bad_id_on_either_side(self, store, mapping):
        before = store.files()
        response = store.client.post(f"/character-assets/{PERSONA}/migrate-ids", json={"id_mapping": mapping})
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid id.")
        assert store.files() == before

    def test_a_plain_name_is_accepted_everywhere(self, store):
        assert store.client.get(f"/character-assets/{PERSONA}/p1/base").status_code == 200
        assert store.client.get(f"/character-assets/{PERSONA}/edges/e1").status_code == 200
        response = store.client.post(
            f"/character-assets/{PERSONA}/migrate-ids", json={"id_mapping": {"p2": "p3"}}
        )
        assert response.status_code == 200
        assert "p3/base.png" in store.files()
