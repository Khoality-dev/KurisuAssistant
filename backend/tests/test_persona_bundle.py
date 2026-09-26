"""A persona export that carries its character, and the import that restores it (#248).

``GET /personas/{id}/export`` is still the v3 JSON file, character left behind.
``?character=true`` makes it a v4 bundle: a zip holding ``persona.json`` — the v3
fields plus the character config, its URLs written against a ``{persona_id}``
placeholder, and a manifest of the files — and the files themselves under
``character/``. ``GET /personas/{id}/export/size`` says how big that is before
anyone downloads it. ``POST /personas/import/bundle`` streams a bundle in and
creates a persona whose config names *its own* id.

A bundle is untrusted input from another install, so the import re-derives
everything the upload routes would: every file must match its manifest entry,
sit where the store would have put it and fit its kind's ceiling; the model and
clips are inspected like an upload; their refs are rebuilt here, not read from
the file; the config goes through the same write path as a save, so a URL naming
any other persona is refused; and the model and clips are metered against the
account's quota in the transaction that creates the persona. Nothing is created,
and nothing is left on disk, when any of that fails.

The store is ``tmp_path``; the database is the stub repository of the upload
tests, which runs each callable inline like the single database thread does.
"""

import io
import json
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.character import assets, bundle, paths
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import character, personas
from tests.test_character_uploads import glb, sha, vrm0, vrm1, vrma

USER = 1
PERSONA = 1
PLACEHOLDER = "/character-assets/{persona_id}/"


# ── the stub database ────────────────────────────────────────────────────────


class FakePersona:
    def __init__(self, persona_id, user_id, name, config=None, **fields):
        self.id = persona_id
        self.user_id = user_id
        self.name = name
        self.description = fields.get("description", "")
        self.system_prompt = fields.get("system_prompt", "")
        self.preferred_name = fields.get("preferred_name")
        self.voice_reference = None
        self.avatar_uuid = None
        self.character_config = config
        self.enabled = True


class FakePersonaRepository:
    personas: list = []

    def __init__(self, session):
        pass

    def get_by_user_and_id(self, user_id, persona_id):
        return next((p for p in self.personas if p.user_id == user_id and p.id == persona_id), None)

    def get_by_user_and_name(self, user_id, name):
        return next((p for p in self.personas if p.user_id == user_id and p.name == name), None)

    def list_by_user(self, user_id):
        return [p for p in self.personas if p.user_id == user_id]

    def create_persona(self, user_id, name, character_config=None, **fields):
        persona = FakePersona(max((p.id for p in self.personas), default=0) + 1, user_id, name,
                              character_config, **fields)
        self.personas.append(persona)
        return persona

    def update_persona(self, persona, **fields):
        for key, value in fields.items():
            setattr(persona, key, value)
        return persona

    def delete_by_user_and_id(self, user_id, persona_id):
        self.personas[:] = [p for p in self.personas if not (p.user_id == user_id and p.id == persona_id)]
        return True


class FakeDBService:
    """Runs the callable inline and, like the real service, undoes it when it raises."""

    async def execute(self, operation, timeout=None):
        before = list(FakePersonaRepository.personas)
        configs = {p.id: p.character_config for p in before}
        try:
            return operation(None)
        except BaseException:
            FakePersonaRepository.personas[:] = before
            for p in before:
                p.character_config = configs[p.id]
            raise


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "CHAR_ASSETS_DIR", tmp_path)
    FakePersonaRepository.personas = [
        FakePersona(PERSONA, USER, "Kurisu", {"kind": "pose_graph", "pose_tree": {
            "default_pose_ids": [], "nodes": [], "edges": []}},
            description="lab member", system_prompt="You are Kurisu.", preferred_name="Okabe"),
        FakePersona(9, 2, "Someone else's", None),
    ]
    for module in (character, personas):
        monkeypatch.setattr(module, "PersonaRepository", FakePersonaRepository)
        monkeypatch.setattr(module, "get_db_service", lambda: FakeDBService())
    application = FastAPI()
    application.dependency_overrides[get_authenticated_user] = lambda: type("U", (), {"id": USER, "username": "t"})()
    application.include_router(character.router)
    application.include_router(personas.router)
    return application


@pytest.fixture
def client(app):
    return TestClient(app, raise_server_exceptions=False)


def persona(persona_id):
    return next(p for p in FakePersonaRepository.personas if p.id == persona_id)


def persona_named(name):
    return next((p for p in FakePersonaRepository.personas if p.name == name), None)


def user_persona_count():
    return len([p for p in FakePersonaRepository.personas if p.user_id == USER])


def put_model(client, data, persona_id=PERSONA):
    response = client.put(f"/character-assets/{persona_id}/vrm/model",
                          params={"sha256": sha(data), "filename": "kurisu.vrm"}, content=data)
    assert response.status_code == 200, response.text
    return response.json()


def put_clip(client, data, persona_id=PERSONA, name="wave", loop=False):
    response = client.put(f"/character-assets/{persona_id}/vrma",
                          params={"sha256": sha(data), "name": name, "loop": str(loop).lower()}, content=data)
    assert response.status_code == 200, response.text
    return response.json()["clip"]


def with_vrm_character(client, kind="vrm"):
    """Persona 1 with a model, one clip its idle rotation plays, and ``kind``."""
    model = vrm1()
    put_model(client, model)
    clip_bytes = vrma()
    clip = put_clip(client, clip_bytes, name="wave", loop=True)
    config = persona(PERSONA).character_config
    config = {**config, "kind": kind}
    config["vrm"] = {**config["vrm"], "idle": {**config["vrm"]["idle"], "idle_clip_ids": [clip["id"]]}}
    response = client.patch(f"/character-assets/{PERSONA}/character-config", json=config)
    assert response.status_code == 200, response.text
    return model, clip_bytes, clip


POSE_TREE = {
    "default_pose_ids": ["p1"],
    "nodes": [{"id": "p1", "pose_config": {
        "base_image_url": "/character-assets/1/p1/base",
        "mouth": {"patches": [{"image_url": "/character-assets/1/p1/mouth_0", "x": 1, "y": 2, "width": 3, "height": 4}]},
    }}],
    "edges": [{"id": "e1", "source": "p1", "target": "p1",
               "transitions": [{"video_urls": ["/character-assets/1/edges/e1"]}]}],
}


def with_pose_character(tmp_path):
    """Persona 1 with a pose graph whose three files are on disk, and one stray file."""
    base = tmp_path / "1" / "p1"
    base.mkdir(parents=True)
    (base / "base.png").write_bytes(b"\x89PNG base")
    (base / "mouth_0.png").write_bytes(b"\x89PNG mouth")
    (tmp_path / "1" / "edges").mkdir()
    (tmp_path / "1" / "edges" / "e1.mp4").write_bytes(b"mp4 bytes")
    (base / "stray.png").write_bytes(b"not referenced")
    persona(PERSONA).character_config = {"kind": "pose_graph", "pose_tree": json.loads(json.dumps(POSE_TREE))}


def export_bundle(client, persona_id=PERSONA) -> zipfile.ZipFile:
    response = client.get(f"/personas/{persona_id}/export", params={"character": "true"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    return zipfile.ZipFile(io.BytesIO(response.content))


def manifest(archive: zipfile.ZipFile) -> dict:
    return json.loads(archive.read("persona.json"))


def make_bundle(meta: dict, files: dict[str, bytes], extra: dict[str, bytes] | None = None) -> bytes:
    """A bundle: ``persona.json`` from ``meta`` and each file under ``character/``."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("persona.json", json.dumps(meta))
        for path, data in files.items():
            archive.writestr(f"character/{path}", data)
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return out.getvalue()


def vrm_meta(model: bytes, clip: bytes | None = None, clip_id="0a1b2c3d", **overrides) -> dict:
    """A v4 persona.json with a VRM character: the model, and optionally one clip."""
    clips = []
    files = [{"path": f"vrm/{sha(model)}.vrm", "bytes": len(model), "sha256": sha(model)}]
    if clip is not None:
        clips.append({"id": clip_id, "name": "wave", "url": f"{PLACEHOLDER}vrma/{clip_id}",
                      "sha256": sha(clip), "bytes": len(clip), "loop": True})
        files.append({"path": f"vrma/{clip_id}.vrma", "bytes": len(clip), "sha256": sha(clip)})
    from kurisuassistant.character.schema import VrmSettings
    settings = VrmSettings().model_dump(mode="json")
    settings["model"] = {"url": f"{PLACEHOLDER}vrm/model", "sha256": sha(model), "bytes": len(model),
                         "uploaded_at": "2026-09-20T10:00:00Z", "filename": "kurisu.vrm",
                         "spec_version": "1.0", "expressions": ["neutral"]}
    settings["clips"] = clips
    meta = {
        "version": 4, "kind": "persona", "name": "Imported", "description": "d",
        "system_prompt": "p", "preferred_name": None,
        "character": {"config": {"kind": "vrm", "vrm": settings}, "files": files},
    }
    meta.update(overrides)
    return meta


def import_bundle(client, data: bytes):
    return client.post("/personas/import/bundle", content=data,
                       headers={"Content-Type": "application/zip"})


def left_on_disk(tmp_path) -> list[str]:
    """Every file under the store except persona 1's own."""
    return sorted(
        p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*")
        if p.is_file() and not p.relative_to(tmp_path).as_posix().startswith("1/")
    )


# ── export ───────────────────────────────────────────────────────────────────


class TestExport:
    def test_without_the_flag_it_is_still_the_v3_json(self, client):
        with_vrm_character(client)
        response = client.get(f"/personas/{PERSONA}/export")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/json")
        meta = response.json()
        assert meta["version"] == 3
        assert "character" not in meta and "character_config" not in meta

    def test_a_bundle_carries_the_model_its_clips_and_a_portable_config(self, client):
        model, clip_bytes, clip = with_vrm_character(client)
        archive = export_bundle(client)
        meta = manifest(archive)
        assert meta["version"] == 4 and meta["kind"] == "persona"
        assert (meta["name"], meta["description"], meta["system_prompt"], meta["preferred_name"]) == (
            "Kurisu", "lab member", "You are Kurisu.", "Okabe")

        character_meta = meta["character"]
        config = character_meta["config"]
        assert config["kind"] == "vrm"
        assert config["vrm"]["model"]["url"] == f"{PLACEHOLDER}vrm/model"
        assert config["vrm"]["clips"][0]["url"] == f"{PLACEHOLDER}vrma/{clip['id']}"
        assert "/character-assets/1/" not in json.dumps(meta)

        files = {f["path"]: f for f in character_meta["files"]}
        assert set(files) == {f"vrm/{sha(model)}.vrm", f"vrma/{clip['id']}.vrma"}
        assert archive.read(f"character/vrm/{sha(model)}.vrm") == model
        assert archive.read(f"character/vrma/{clip['id']}.vrma") == clip_bytes
        assert files[f"vrm/{sha(model)}.vrm"] == {
            "path": f"vrm/{sha(model)}.vrm", "bytes": len(model), "sha256": sha(model)}

    def test_pose_art_travels_and_a_file_nothing_references_does_not(self, client, tmp_path):
        with_pose_character(tmp_path)
        archive = export_bundle(client)
        names = sorted(n for n in archive.namelist() if n != "persona.json")
        assert names == ["character/edges/e1.mp4", "character/p1/base.png", "character/p1/mouth_0.png"]
        tree = manifest(archive)["character"]["config"]["pose_tree"]
        assert tree["nodes"][0]["pose_config"]["base_image_url"] == f"{PLACEHOLDER}p1/base"
        assert tree["edges"][0]["transitions"][0]["video_urls"] == [f"{PLACEHOLDER}edges/e1"]

    def test_both_members_travel_whichever_one_shows(self, client, tmp_path):
        with_pose_character(tmp_path)
        persona(PERSONA).character_config["kind"] = "vrm"
        model = vrm1()
        put_model(client, model)
        meta = manifest(export_bundle(client))
        assert set(meta["character"]["config"]) == {"kind", "pose_tree", "vrm"}
        assert f"vrm/{sha(model)}.vrm" in {f["path"] for f in meta["character"]["files"]}

    # A config naming a file the store does not hold is the store contradicting
    # itself — a fault to surface, never to paper over: a bundle that quietly
    # left the model out would restore a persona with no character (#248).

    def test_a_referenced_model_missing_from_disk_fails_the_export_loudly(self, client, caplog):
        model, _, _ = with_vrm_character(client)
        (paths.persona_dir(PERSONA) / "vrm" / f"{sha(model)}.vrm").unlink()
        with caplog.at_level("ERROR"):
            response = client.get(f"/personas/{PERSONA}/export", params={"character": "true"})
        assert response.status_code == 500
        assert response.json()["detail"]["code"] == "character_files_missing"
        assert any(r.levelname == "ERROR" and f"persona {PERSONA}" in r.getMessage()
                   and sha(model) in r.getMessage() for r in caplog.records)
        size = client.get(f"/personas/{PERSONA}/export/size")
        assert size.status_code == 500
        assert size.json()["detail"]["code"] == "character_files_missing"

    def test_a_referenced_clip_missing_from_disk_fails_the_export_loudly(self, client):
        _, _, clip = with_vrm_character(client)
        (paths.persona_dir(PERSONA) / "vrma" / f"{clip['id']}.vrma").unlink()
        response = client.get(f"/personas/{PERSONA}/export", params={"character": "true"})
        assert response.status_code == 500
        assert response.json()["detail"]["code"] == "character_files_missing"

    def test_pose_art_missing_from_disk_fails_the_export_loudly(self, client, tmp_path):
        with_pose_character(tmp_path)
        (paths.persona_dir(PERSONA) / "p1" / "base.png").unlink()
        response = client.get(f"/personas/{PERSONA}/export", params={"character": "true"})
        assert response.status_code == 500
        assert response.json()["detail"]["code"] == "character_files_missing"

    def test_a_persona_with_no_character_exports_a_bundle_without_one(self, client):
        persona(PERSONA).character_config = None
        archive = export_bundle(client)
        assert archive.namelist() == ["persona.json"]
        assert manifest(archive)["character"] is None

    def test_the_filename_is_a_zip(self, client):
        response = client.get(f"/personas/{PERSONA}/export", params={"character": "true"})
        assert 'filename="Kurisu.zip"' in response.headers["content-disposition"]

    def test_someone_elses_persona_is_404(self, client):
        assert client.get("/personas/9/export", params={"character": "true"}).status_code == 404
        assert client.get("/personas/9/export/size").status_code == 404


class TestExportSize:
    def test_says_how_big_the_character_is_before_the_download(self, client):
        model, clip_bytes, _ = with_vrm_character(client)
        response = client.get(f"/personas/{PERSONA}/export/size")
        assert response.status_code == 200
        assert response.json() == {"character": {
            "kind": "vrm", "files": 2, "bytes": len(model) + len(clip_bytes),
            "vrm_bytes": len(model) + len(clip_bytes)}}

    def test_counts_pose_art_but_meters_only_the_vrm_bytes(self, client, tmp_path):
        with_pose_character(tmp_path)
        size = client.get(f"/personas/{PERSONA}/export/size").json()["character"]
        assert size == {"kind": "pose_graph", "files": 3,
                        "bytes": len(b"\x89PNG base") + len(b"\x89PNG mouth") + len(b"mp4 bytes"),
                        "vrm_bytes": 0}

    def test_no_character_is_null(self, client):
        persona(PERSONA).character_config = None
        assert client.get(f"/personas/{PERSONA}/export/size").json() == {"character": None}

    def test_matches_what_the_export_then_holds(self, client, tmp_path):
        with_pose_character(tmp_path)
        size = client.get(f"/personas/{PERSONA}/export/size").json()["character"]
        archive = export_bundle(client)
        held = [i for i in archive.infolist() if i.filename != "persona.json"]
        assert (size["files"], size["bytes"]) == (len(held), sum(i.file_size for i in held))


# ── import ───────────────────────────────────────────────────────────────────


class TestImport:
    def test_an_exported_vrm_persona_comes_back_under_its_new_id(self, client, tmp_path):
        model, clip_bytes, clip = with_vrm_character(client)
        data = export_bundle(client).fp.getvalue()

        response = import_bundle(client, data)
        assert response.status_code == 200, response.text
        body = response.json()
        new_id = body["id"]
        assert new_id != PERSONA
        assert body["name"] == "Kurisu (2)"
        assert (body["description"], body["system_prompt"], body["preferred_name"]) == (
            "lab member", "You are Kurisu.", "Okabe")

        config = persona(new_id).character_config
        assert config["kind"] == "vrm"
        assert config["vrm"]["model"]["url"] == f"/character-assets/{new_id}/vrm/model"
        assert config["vrm"]["model"]["sha256"] == sha(model)
        assert config["vrm"]["model"]["bytes"] == len(model)
        assert config["vrm"]["clips"] == [{**clip, "url": f"/character-assets/{new_id}/vrma/{clip['id']}"}]
        assert config["vrm"]["idle"]["idle_clip_ids"] == [clip["id"]]
        assert "/character-assets/1/" not in json.dumps(config)

        assert (tmp_path / str(new_id) / "vrm" / f"{sha(model)}.vrm").read_bytes() == model
        assert (tmp_path / str(new_id) / "vrma" / f"{clip['id']}.vrma").read_bytes() == clip_bytes
        served = client.get(f"/character-assets/{new_id}/vrm/model")
        assert served.status_code == 200 and served.content == model

    def test_the_original_persona_is_untouched(self, client, tmp_path):
        model, _, _ = with_vrm_character(client)
        before = json.dumps(persona(PERSONA).character_config, sort_keys=True)
        assert import_bundle(client, export_bundle(client).fp.getvalue()).status_code == 200
        assert json.dumps(persona(PERSONA).character_config, sort_keys=True) == before
        assert (tmp_path / "1" / "vrm" / f"{sha(model)}.vrm").exists()

    def test_a_pose_graph_comes_back_with_its_art(self, client, tmp_path):
        with_pose_character(tmp_path)
        response = import_bundle(client, export_bundle(client).fp.getvalue())
        assert response.status_code == 200, response.text
        new_id = response.json()["id"]
        tree = persona(new_id).character_config["pose_tree"]
        assert tree["nodes"][0]["pose_config"]["base_image_url"] == f"/character-assets/{new_id}/p1/base"
        assert (tmp_path / str(new_id) / "p1" / "base.png").read_bytes() == b"\x89PNG base"
        assert (tmp_path / str(new_id) / "p1" / "mouth_0.png").read_bytes() == b"\x89PNG mouth"
        assert (tmp_path / str(new_id) / "edges" / "e1.mp4").read_bytes() == b"mp4 bytes"
        assert not (tmp_path / str(new_id) / "p1" / "stray.png").exists()

    def test_the_model_ref_is_rebuilt_from_the_file_not_read_from_the_bundle(self, client, tmp_path):
        model = vrm0()
        meta = vrm_meta(model)
        meta["character"]["config"]["vrm"]["model"].update(spec_version="1.0", expressions=["surprised"],
                                                           filename="x" * 500)
        response = import_bundle(client, make_bundle(meta, {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 200, response.text
        ref = persona(response.json()["id"]).character_config["vrm"]["model"]
        assert ref["spec_version"] == "0.x"
        assert "surprised" not in ref["expressions"]
        assert len(ref["filename"]) <= assets.FILENAME_MAX_CHARS

    def test_a_bundle_without_a_character_imports_the_persona_alone(self, client):
        meta = {"version": 4, "kind": "persona", "name": "Plain", "description": "", "system_prompt": "",
                "preferred_name": None, "character": None}
        response = import_bundle(client, make_bundle(meta, {}))
        assert response.status_code == 200, response.text
        assert persona(response.json()["id"]).character_config is None

    def test_the_staging_area_is_empty_afterwards(self, client, tmp_path):
        model = vrm1()
        assert import_bundle(client, make_bundle(vrm_meta(model), {f"vrm/{sha(model)}.vrm": model})).status_code == 200
        incoming = tmp_path / paths.INCOMING_DIR_NAME
        assert not incoming.exists() or list(incoming.iterdir()) == []


    def test_a_failure_placing_the_files_takes_the_new_persona_back_out(self, client, tmp_path, monkeypatch):
        model = vrm1()
        count = user_persona_count()

        def fail(*args):
            raise OSError("disk full")

        monkeypatch.setattr(bundle, "place", fail)
        response = import_bundle(client, make_bundle(vrm_meta(model), {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 500
        assert user_persona_count() == count
        assert left_on_disk(tmp_path) == []


class TestImportQuota:
    def test_a_character_over_the_quota_is_507_and_nothing_is_created(self, client, tmp_path, monkeypatch):
        model = vrm1()
        put_model(client, model)  # persona 1 already uses len(model)
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(model) + 10)
        count = user_persona_count()
        response = import_bundle(client, make_bundle(vrm_meta(model), {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 507, response.text
        assert response.json()["detail"]["code"] == "quota"
        assert user_persona_count() == count
        assert left_on_disk(tmp_path) == []

    def test_a_character_that_fits_exactly_is_accepted(self, client, monkeypatch):
        model = vrm1()
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(model))
        response = import_bundle(client, make_bundle(vrm_meta(model), {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 200, response.text

    def test_pose_art_is_not_metered(self, client, tmp_path, monkeypatch):
        with_pose_character(tmp_path)
        data = export_bundle(client).fp.getvalue()
        monkeypatch.setattr(assets, "QUOTA_BYTES", 0)
        assert import_bundle(client, data).status_code == 200


class TestImportRefusals:
    """Each refusal creates no persona and leaves nothing on disk."""

    @pytest.fixture(autouse=True)
    def nothing_created(self, client, tmp_path):
        count = user_persona_count()
        yield
        assert user_persona_count() == count
        assert left_on_disk(tmp_path) == []

    def test_not_a_zip_is_400(self, client):
        response = import_bundle(client, b"this is not a zip")
        assert response.status_code == 400

    def test_a_zip_without_persona_json_is_400(self, client):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            archive.writestr("readme.txt", "hi")
        assert import_bundle(client, out.getvalue()).status_code == 400

    def test_a_sub_agent_file_is_400_and_says_where_it_goes(self, client):
        meta = {"version": 3, "kind": "sub_agent", "name": "x"}
        response = import_bundle(client, make_bundle(meta, {}))
        assert response.status_code == 400
        assert "sub-agent" in response.json()["detail"]

    def test_a_file_that_does_not_match_its_manifest_is_400(self, client):
        model = vrm1()
        tampered = model[:-1] + b"!"
        response = import_bundle(client, make_bundle(vrm_meta(model), {f"vrm/{sha(model)}.vrm": tampered}))
        assert response.status_code == 400

    def test_a_file_bigger_than_its_manifest_says_is_400(self, client):
        model = vrm1()
        meta = vrm_meta(model)
        meta["character"]["files"][0]["bytes"] = 10
        response = import_bundle(client, make_bundle(meta, {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 400

    def test_a_damaged_entry_is_400_not_a_server_error(self, client):
        model = vrm1()
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("persona.json", json.dumps(vrm_meta(model)))
            archive.writestr(f"character/vrm/{sha(model)}.vrm", model)
        data = bytearray(out.getvalue())
        at = data.index(b"character/vrm/") + len(f"character/vrm/{sha(model)}.vrm")
        data[at:at + 16] = b"\xff" * 16  # garble the deflate stream right after the local header
        assert import_bundle(client, bytes(data)).status_code == 400

    def test_a_listed_file_missing_from_the_zip_is_400(self, client):
        model = vrm1()
        assert import_bundle(client, make_bundle(vrm_meta(model), {})).status_code == 400

    def test_a_model_that_is_not_a_vrm_is_415(self, client):
        not_vrm = glb({"asset": {"version": "2.0"}})
        response = import_bundle(client, make_bundle(vrm_meta(not_vrm), {f"vrm/{sha(not_vrm)}.vrm": not_vrm}))
        assert response.status_code == 415
        assert response.json()["detail"]["code"] == "not_vrm"

    def test_a_clip_that_is_not_a_vrma_is_415(self, client):
        model, fake_clip = vrm1(), vrm1(presets=("happy",))
        files = {f"vrm/{sha(model)}.vrm": model, "vrma/0a1b2c3d.vrma": fake_clip}
        response = import_bundle(client, make_bundle(vrm_meta(model, fake_clip), files))
        assert response.status_code == 415

    def test_a_model_over_its_ceiling_is_413(self, client, monkeypatch):
        model = vrm1()
        monkeypatch.setattr(assets, "MODEL_MAX_BYTES", len(model) - 1)
        response = import_bundle(client, make_bundle(vrm_meta(model), {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 413

    def test_a_bundle_has_no_size_ceiling_of_its_own(self):
        """The owner's call (#248): no bundle-wide cap. What a bundle may hold is
        bounded by each file's own ceiling and the account's quota, as uploads are."""
        assert not hasattr(bundle, "BUNDLE_MAX_BYTES")

    @pytest.mark.parametrize("path", [
        "../escape.png", "p1/../../escape.png", "/abs/base.png", "p1/sub/base.png",
        "p1/base.exe", "vrm/model.vrm", "vrma/not-hex.vrma", ".incoming/x.png",
        "vrm/base.png", "p1/.png", "p1\\base.png",
    ])
    def test_a_path_the_store_would_never_write_is_400(self, client, path):
        meta = {"version": 4, "kind": "persona", "name": "Bad", "description": "", "system_prompt": "",
                "preferred_name": None,
                "character": {"config": {"kind": "pose_graph", "pose_tree": {
                    "default_pose_ids": [], "nodes": [], "edges": []}},
                    "files": [{"path": path, "bytes": 3, "sha256": sha(b"abc")}]}}
        response = import_bundle(client, make_bundle(meta, {path: b"abc"}))
        assert response.status_code == 400, path

    def test_a_config_naming_another_persona_is_422(self, client):
        meta = {"version": 4, "kind": "persona", "name": "Foreign", "description": "", "system_prompt": "",
                "preferred_name": None,
                "character": {"config": {"kind": "pose_graph", "pose_tree": {
                    "default_pose_ids": [], "edges": [],
                    "nodes": [{"id": "p1", "pose_config": {"base_image_url": "/character-assets/1/p1/base"}}]}},
                    "files": []}}
        response = import_bundle(client, make_bundle(meta, {}))
        assert response.status_code == 422

    def test_a_config_the_schema_refuses_is_422(self, client):
        model = vrm1()
        meta = vrm_meta(model)
        meta["character"]["config"]["vrm"]["not_a_setting"] = True
        response = import_bundle(client, make_bundle(meta, {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 422

    def test_a_clip_the_idle_rotation_names_but_the_bundle_lacks_is_422(self, client):
        model = vrm1()
        meta = vrm_meta(model)
        meta["character"]["config"]["vrm"]["idle"]["idle_clip_ids"] = ["deadbeef"]
        response = import_bundle(client, make_bundle(meta, {f"vrm/{sha(model)}.vrm": model}))
        assert response.status_code == 422

    def test_a_model_the_config_names_but_the_bundle_lacks_is_400(self, client):
        model = vrm1()
        meta = vrm_meta(model)
        meta["character"]["files"] = []
        assert import_bundle(client, make_bundle(meta, {})).status_code == 400

    def test_too_many_files_is_400(self, client, monkeypatch):
        monkeypatch.setattr(bundle, "BUNDLE_MAX_FILES", 1)
        model, clip = vrm1(), vrma()
        files = {f"vrm/{sha(model)}.vrm": model, "vrma/0a1b2c3d.vrma": clip}
        assert import_bundle(client, make_bundle(vrm_meta(model, clip), files)).status_code == 400

    def test_a_zip_with_more_entries_than_a_bundle_can_list_is_refused_before_it_is_read(self, client, monkeypatch):
        # The central directory is parsed whole when a zip is opened, so its
        # size is checked from the end record first: millions of tiny entries
        # would otherwise become millions of objects before any other check.
        meta = {"version": 4, "kind": "persona", "name": "Many", "description": "", "system_prompt": "",
                "preferred_name": None, "character": None}
        data = make_bundle(meta, {}, extra={f"junk/{i}": b"" for i in range(5)})
        monkeypatch.setattr(bundle, "BUNDLE_MAX_FILES", 1)
        opened = []

        class Refuse:
            def __init__(self, *args, **kwargs):
                opened.append(args)
                raise AssertionError("the zip was opened")

        monkeypatch.setattr(bundle.zipfile, "ZipFile", Refuse)
        response = import_bundle(client, data)
        assert response.status_code == 400
        assert opened == []

    def test_an_unsupported_version_is_400(self, client):
        meta = vrm_meta(vrm1(), version=5)
        assert import_bundle(client, make_bundle(meta, {})).status_code == 400


class TestJsonImport:
    def test_a_v4_manifest_posted_as_json_says_to_import_the_zip(self, client):
        meta = vrm_meta(vrm1())
        response = client.post("/personas/import",
                               files={"file": ("persona.json", json.dumps(meta).encode(), "application/json")})
        assert response.status_code == 400
        assert ".zip" in response.json()["detail"]

    def test_a_v3_file_still_imports(self, client):
        meta = {"version": 3, "kind": "persona", "name": "Old", "description": "", "system_prompt": ""}
        response = client.post("/personas/import",
                               files={"file": ("old.json", json.dumps(meta).encode(), "application/json")})
        assert response.status_code == 200, response.text


@pytest.mark.parametrize("method, path", [
    ("post", "/personas/import/bundle"),
    ("get", f"/personas/{PERSONA}/export/size"),
    ("get", f"/personas/{PERSONA}/export?character=true"),
])
def test_without_a_token_nothing_is_read_or_written(tmp_path, monkeypatch, method, path):
    monkeypatch.setattr(paths, "CHAR_ASSETS_DIR", tmp_path)
    application = FastAPI()
    application.include_router(personas.router)
    unauthenticated = TestClient(application, raise_server_exceptions=False)
    response = getattr(unauthenticated, method)(path, **({"content": b"PK"} if method == "post" else {}))
    assert response.status_code in (401, 403)
    assert list(tmp_path.iterdir()) == []


def test_nginx_puts_no_ceiling_on_a_bundle():
    """The server-wide 50M would refuse most bundles with an HTML page before the
    backend saw them, and a bundle has no ceiling of its own (#248)."""
    import re
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / "nginx" / "nginx.conf").read_text()
    block = re.search(r"location = /personas/import/bundle \{(.*?)\n    \}", text, re.S)
    assert block, "no location for the bundle import"
    assert "client_max_body_size 0;" in block.group(1)
    assert "proxy_request_buffering off;" in block.group(1)
