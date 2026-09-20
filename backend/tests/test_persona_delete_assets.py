"""A deleted persona takes its character assets with it, and the sweep finds the rest.

Regression cover for #234. ``DELETE /personas/{id}`` removed the row and left
``data/character_assets/{id}/`` behind forever, and nothing listed the
directories that belonged to no persona.

Same shape as ``test_character_router.py``: the store is ``tmp_path`` through
``kurisuassistant.character.paths.CHAR_ASSETS_DIR`` and the database is a stub.
"""

import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.character import paths
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import personas
from scripts import sweep_character_assets

DELETED = 1
KEPT = 2


class FakePersona:
    def __init__(self, persona_id, user_id=1):
        self.id = persona_id
        self.user_id = user_id


class FakePersonaRepository:
    deleted: list = []

    def __init__(self, session):
        pass

    def list_by_user(self, user_id):
        return [FakePersona(DELETED), FakePersona(KEPT)]

    def delete_by_user_and_id(self, user_id, persona_id):
        FakePersonaRepository.deleted.append(persona_id)
        return True


class FakeAssistantRepository:
    def __init__(self, session):
        pass

    def get_by_user(self, user_id):
        return None


class FakeDBService:
    async def execute(self, operation, timeout=None):
        return operation(None)


def seed(root, persona_id, files=("p1/base.png", "edges/e1.mp4")):
    for rel in files:
        path = root / str(persona_id) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"xxxx")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "CHAR_ASSETS_DIR", tmp_path)
    FakePersonaRepository.deleted = []
    monkeypatch.setattr(personas, "PersonaRepository", FakePersonaRepository)
    monkeypatch.setattr(personas, "AssistantRepository", FakeAssistantRepository)
    monkeypatch.setattr(personas, "get_db_service", lambda: FakeDBService())

    app = FastAPI()
    app.dependency_overrides[get_authenticated_user] = lambda: type("U", (), {"id": 1, "username": "t"})()
    app.include_router(personas.router)
    return TestClient(app, raise_server_exceptions=False)


class TestDeletePersona:
    def test_removes_its_directory_and_leaves_the_others(self, client, tmp_path):
        seed(tmp_path, DELETED)
        seed(tmp_path, KEPT)
        response = client.delete(f"/personas/{DELETED}")
        assert response.status_code == 200
        assert FakePersonaRepository.deleted == [DELETED]
        assert not (tmp_path / str(DELETED)).exists()
        assert (tmp_path / str(KEPT) / "p1" / "base.png").exists()

    def test_a_persona_with_no_directory_deletes_fine(self, client, tmp_path):
        response = client.delete(f"/personas/{DELETED}")
        assert response.status_code == 200
        assert FakePersonaRepository.deleted == [DELETED]
        assert not (tmp_path / str(DELETED)).exists()


class TestSweep:
    @pytest.fixture
    def root(self, tmp_path):
        seed(tmp_path, 1)           # live
        seed(tmp_path, 9)           # orphan
        seed(tmp_path, 10, ("edges/e1.mp4",))  # orphan
        (tmp_path / "notes").mkdir()            # not a persona id
        (tmp_path / "stray.txt").write_bytes(b"x")
        return tmp_path

    def test_dry_run_lists_the_orphans_and_removes_nothing(self, root):
        out = io.StringIO()
        found = sweep_character_assets.sweep(root, live_ids={1}, apply=False, out=out)
        assert [(d.name, size) for d, size in found.orphans] == [("10", 4), ("9", 8)]
        assert [e.name for e in found.unrecognised] == ["notes", "stray.txt"]
        assert (root / "9").exists() and (root / "10").exists() and (root / "1").exists()
        assert "would remove" in out.getvalue() and "--apply" in out.getvalue()

    def test_apply_removes_only_the_orphans(self, root):
        found = sweep_character_assets.sweep(root, live_ids={1}, apply=True, out=io.StringIO())
        assert [d.name for d, _ in found.orphans] == ["10", "9"]
        assert not (root / "9").exists() and not (root / "10").exists()
        assert (root / "1" / "p1" / "base.png").exists()
        assert (root / "notes").exists() and (root / "stray.txt").exists()

    def test_a_missing_root_is_empty(self, tmp_path):
        found = sweep_character_assets.find_orphans(tmp_path / "nope", live_ids=set())
        assert found.orphans == [] and found.unrecognised == []
