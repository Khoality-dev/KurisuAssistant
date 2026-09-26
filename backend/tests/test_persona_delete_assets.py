"""A deleted persona takes its character assets with it, and the sweep finds the rest.

Regression cover for #234. ``DELETE /personas/{id}`` removed the row and left
``data/character_assets/{id}/`` behind forever, and nothing listed the
directories that belonged to no persona.

Same shape as ``test_character_router.py``: the store is ``tmp_path`` through
``kurisuassistant.character.paths.CHAR_ASSETS_DIR`` and the database is a stub.
"""

import io
import logging
import os
import stat
from pathlib import Path

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
    # What the caller owns; a test narrows it to model "not yours" and "only one".
    owned: list = [DELETED, KEPT]

    def __init__(self, session):
        pass

    def list_by_user(self, user_id):
        return [FakePersona(pid) for pid in FakePersonaRepository.owned]

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
    FakePersonaRepository.owned = [DELETED, KEPT]
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

    # The refusal below holds on the pre-#234 route as well (it removed
    # nothing, ever); it pins that the directory is only ever removed *after*
    # a delete the route accepted — the persona id comes from the URL, and only
    # the DB step checks it is the caller's.
    def test_a_persona_that_is_not_yours_is_refused_and_its_directory_stays(self, client, tmp_path):
        FakePersonaRepository.owned = [KEPT]
        seed(tmp_path, DELETED)
        response = client.delete(f"/personas/{DELETED}")
        assert response.status_code == 404
        assert FakePersonaRepository.deleted == []
        assert (tmp_path / str(DELETED) / "p1" / "base.png").exists()

    def test_the_only_persona_is_deleted_with_its_directory(self, client, tmp_path):
        """The assistant answers without one, so the last persona is not kept back (#302)."""
        FakePersonaRepository.owned = [DELETED]
        seed(tmp_path, DELETED)
        response = client.delete(f"/personas/{DELETED}")
        assert response.status_code == 200
        assert FakePersonaRepository.deleted == [DELETED]
        assert not (tmp_path / str(DELETED)).exists()

    def test_a_file_that_cannot_be_measured_does_not_fail_the_delete(self, client, tmp_path, monkeypatch):
        seed(tmp_path, DELETED)
        real_stat = Path.stat

        def flaky_stat(self, *args, **kwargs):
            if self.name == "base.png":
                raise PermissionError(13, "Permission denied", str(self))
            return real_stat(self, *args, **kwargs)

        monkeypatch.setattr(Path, "stat", flaky_stat)
        response = client.delete(f"/personas/{DELETED}")
        assert response.status_code == 200
        assert FakePersonaRepository.deleted == [DELETED]
        assert not (tmp_path / str(DELETED)).exists()

    def test_a_directory_that_cannot_be_removed_is_logged_and_the_delete_still_succeeds(
        self, client, tmp_path, caplog
    ):
        if os.geteuid() == 0:
            pytest.skip("root ignores directory permissions")
        seed(tmp_path, DELETED)
        pose_dir = tmp_path / str(DELETED) / "p1"
        pose_dir.chmod(stat.S_IRUSR | stat.S_IXUSR)  # no write bit: rmtree cannot unlink base.png
        try:
            with caplog.at_level(logging.WARNING, logger="kurisuassistant.character.references"):
                response = client.delete(f"/personas/{DELETED}")
        finally:
            pose_dir.chmod(stat.S_IRWXU)
        assert response.status_code == 200
        assert FakePersonaRepository.deleted == [DELETED]
        assert (pose_dir / "base.png").exists()
        assert any(
            "left behind" in r.getMessage() and "sweep_character_assets" in r.getMessage()
            for r in caplog.records
        )


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

    def test_the_import_staging_area_is_neither_an_orphan_nor_unrecognised(self, root):
        # A bundle import (#248) stages its files under the store's own
        # `.incoming` before the persona they belong to exists.
        (root / ".incoming").mkdir()
        found = sweep_character_assets.sweep(root, live_ids={1}, apply=True, out=io.StringIO())
        assert ".incoming" not in [d.name for d, _ in found.orphans]
        assert ".incoming" not in [e.name for e in found.unrecognised]
        assert (root / ".incoming").exists()

    def test_a_missing_root_is_empty(self, tmp_path):
        found = sweep_character_assets.find_orphans(tmp_path / "nope", live_ids=set())
        assert found.orphans == [] and found.unrecognised == []

    @pytest.mark.parametrize("name", ["²", "①", "٣", "007", "-1", "1.0", " 1"])
    def test_a_name_that_is_not_a_plain_decimal_is_unrecognised(self, tmp_path, name):
        seed(tmp_path, 1)
        (tmp_path / name).mkdir()
        found = sweep_character_assets.sweep(tmp_path, live_ids={1}, apply=True, out=io.StringIO())
        assert found.orphans == []
        assert [e.name for e in found.unrecognised] == [name]
        assert (tmp_path / name).exists()

    def test_apply_reports_what_it_could_not_remove_and_counts_only_what_went(self, root):
        if os.geteuid() == 0:
            pytest.skip("root ignores directory permissions")
        stuck = root / "9" / "p1"
        stuck.chmod(stat.S_IRUSR | stat.S_IXUSR)
        out = io.StringIO()
        try:
            found = sweep_character_assets.sweep(root, live_ids={1}, apply=True, out=out)
        finally:
            stuck.chmod(stat.S_IRWXU)
        assert [d.name for d in found.left_behind] == ["9"]
        assert (root / "9").exists() and not (root / "10").exists()
        text = out.getvalue()
        assert f"could not remove {root / '9'}" in text
        assert "removed 1 directories, 4 bytes; 1 could not be removed" in text

    @pytest.fixture
    def cli(self, root, monkeypatch):
        monkeypatch.setattr(paths, "CHAR_ASSETS_DIR", root)
        calls = {"live": {1}}
        monkeypatch.setattr(sweep_character_assets, "live_persona_ids", lambda: calls["live"])
        return calls

    def test_main_dry_runs_by_default(self, root, cli):
        out = io.StringIO()
        assert sweep_character_assets.main([], out=out) == 0
        assert (root / "9").exists() and (root / "10").exists()
        assert "1 live persona ids" in out.getvalue()
        assert "would remove" in out.getvalue()

    def test_main_apply_removes_only_the_numeric_orphans(self, root, cli):
        assert sweep_character_assets.main(["--apply"], out=io.StringIO()) == 0
        assert not (root / "9").exists() and not (root / "10").exists()
        assert (root / "1" / "p1" / "base.png").exists()
        assert (root / "notes").exists() and (root / "stray.txt").exists()

    def test_main_apply_refuses_an_empty_database(self, root, cli):
        cli["live"] = set()
        out = io.StringIO()
        assert sweep_character_assets.main(["--apply"], out=out) == 2
        assert "refusing --apply" in out.getvalue() and "--allow-empty-database" in out.getvalue()
        assert (root / "1").exists() and (root / "9").exists() and (root / "10").exists()

    def test_main_apply_with_an_empty_database_when_told_so(self, root, cli):
        cli["live"] = set()
        assert sweep_character_assets.main(["--apply", "--allow-empty-database"], out=io.StringIO()) == 0
        assert not (root / "1").exists() and not (root / "9").exists() and not (root / "10").exists()
        assert (root / "notes").exists()

    def test_main_exits_non_zero_when_something_was_left_behind(self, root, cli):
        if os.geteuid() == 0:
            pytest.skip("root ignores directory permissions")
        stuck = root / "9" / "p1"
        stuck.chmod(stat.S_IRUSR | stat.S_IXUSR)
        try:
            code = sweep_character_assets.main(["--apply"], out=io.StringIO())
        finally:
            stuck.chmod(stat.S_IRWXU)
        assert code == 1
