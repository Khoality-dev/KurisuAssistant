"""What a saved ``character_config`` may delete, and which names a request may use.

Regression cover for #233. Saving a config used to sweep the persona's asset
directory *before* the row was written and to treat any config it did not
understand — a shape without ``pose_tree``, a pose tree pointing at another
persona's ids — as referencing nothing, which emptied the directory. The
persona route wrote the same column and swept nothing. And every id and file
name in the router was joined onto a disk path as sent.

The store is pointed at ``tmp_path`` through the one name every module reads at
call time, ``kurisuassistant.character.paths.CHAR_ASSETS_DIR``; the database is
a stub repository, because none of this is about SQL.
"""

import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.character import paths
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import character, personas

PERSONA = 1
OTHER = 2

# Files a persona owns before each test: two poses (only ``p1`` is referenced by
# the config below), one edge video, and an upload still streaming in.
SEED = ["p1/base.png", "p1/mouth_0.png", "p2/base.png", "edges/e1.mp4", ".incoming/part"]
INCOMING_ONLY = {".incoming/part"}


def pose_tree(persona_id=PERSONA):
    """A config that references ``p1/base``, ``p1/mouth_0`` and ``edges/e1``."""
    prefix = f"/character-assets/{persona_id}"
    return {
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
        self.character_config = {"pose_tree": {"default_pose_ids": [], "nodes": [], "edges": []}}
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


class TestWhatASaveMayDelete:
    @WRITERS
    def test_a_config_that_cannot_be_classified_is_refused_and_nothing_is_unlinked(self, store, write):
        before = store.files()
        response = write(store.client, {"poses": []})
        assert response.status_code == 422
        assert store.files() == before
        assert store.persona.character_config == {"pose_tree": {"default_pose_ids": [], "nodes": [], "edges": []}}

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
    def test_upload_video_refuses_a_bad_edge_id(self, store, bad):
        response = store.client.post(
            f"/character-assets/upload-video?persona_id={PERSONA}&edge_id={bad}",
            files={"file": ("v.mp4", io.BytesIO(b"x"), "video/mp4")},
        )
        assert (response.status_code, response.json()["detail"]) == (400, "Invalid edge_id.")

    @pytest.mark.parametrize("bad", [b for b in SERVING_BAD if b != "edges"])
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
