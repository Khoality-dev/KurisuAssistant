"""VRM models and VRMA clips: upload, validation, limits, serving (#236).

The refs to these files are server-owned: the upload writes ``vrm.model`` /
``vrm.clips`` into the stored config in the transaction that accepts the bytes,
and a config save puts the stored values back over whatever its body says. The
tests below pin that, the bounded validation of the glTF header and JSON chunk,
the per-file ceilings and the per-account quota (measured again inside the write
transaction, so two concurrent uploads cannot both land), and the serving
headers (``ETag`` from the stored sha, 304, ``nosniff``).

The store is ``tmp_path`` through ``paths.CHAR_ASSETS_DIR``; the database is a
stub repository whose ``execute`` runs the callable inline, like the single
database thread does.
"""

import ast
import asyncio
import hashlib
import inspect
import json
import os
import struct
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.character import assets, paths
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import character, personas
from kurisuassistant.utils import blob_stream, drive_storage

PERSONA = 1
OTHER_PERSONA = 2
USER = 1


# ── fixtures: files ─────────────────────────────────────────────────────────


def glb(document, version: int = 2, declared_json_len=None, magic: bytes = b"glTF") -> bytes:
    """A glTF binary with ``document`` as its JSON chunk (padded to 4 bytes)."""
    raw = document if isinstance(document, bytes) else json.dumps(document).encode()
    raw += b" " * (-len(raw) % 4)
    length = len(raw) if declared_json_len is None else declared_json_len
    chunk = struct.pack("<II", length, 0x4E4F534A) + raw
    total = 12 + len(chunk)
    return magic + struct.pack("<II", version, total) + chunk


def vrm1(presets=("happy", "angry", "sad", "relaxed", "surprised", "neutral"), hips=True, **meta):
    bones = {"hips": {"node": 0}} if hips else {"head": {"node": 1}}
    return glb({
        "asset": {"version": "2.0"},
        "extensions": {"VRMC_vrm": {
            "specVersion": "1.0",
            "humanoid": {"humanBones": bones},
            "expressions": {"preset": {name: {} for name in presets}},
            "meta": {"name": "Kurisu", "authors": ["someone"], "licenseUrl": "https://vrm.dev/licenses/1.0/",
                     "avatarPermission": "onlyAuthor", "commercialUsage": "personalNonProfit", **meta},
        }},
    })


def vrm0(hips=True):
    bones = [{"bone": "hips", "node": 0}] if hips else [{"bone": "head", "node": 1}]
    return glb({
        "asset": {"version": "2.0"},
        "extensions": {"VRM": {
            "humanoid": {"humanBones": bones},
            "blendShapeMaster": {"blendShapeGroups": [
                {"presetName": p} for p in ("neutral", "joy", "angry", "sorrow", "fun", "a", "blink")
            ]},
            "meta": {"title": "Old Kurisu", "author": "someone", "licenseName": "CC0",
                     "allowedUserName": "Everyone", "commercialUssageName": "Allow"},
        }},
    })


def vrma():
    return glb({"asset": {"version": "2.0"}, "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0"}}})


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ── fixtures: database ──────────────────────────────────────────────────────


class FakePersona:
    def __init__(self, persona_id, user_id, config=None):
        self.id = persona_id
        self.user_id = user_id
        self.name = f"persona-{persona_id}"
        self.description = ""
        self.system_prompt = ""
        self.preferred_name = None
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
        return None

    def list_by_user(self, user_id):
        return [p for p in self.personas if p.user_id == user_id]

    def update_persona(self, persona, **fields):
        for key, value in fields.items():
            setattr(persona, key, value)
        return persona


class FakeDBService:
    async def execute(self, operation, timeout=None):
        return operation(None)


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "CHAR_ASSETS_DIR", tmp_path)
    FakePersonaRepository.personas = [
        FakePersona(PERSONA, USER, {"kind": "pose_graph", "pose_tree": {"default_pose_ids": [], "nodes": [], "edges": []}}),
        FakePersona(OTHER_PERSONA, USER, None),
        FakePersona(9, 2, None),  # someone else's
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


def persona(persona_id=PERSONA):
    return next(p for p in FakePersonaRepository.personas if p.id == persona_id)


def put_model(client, data, persona_id=PERSONA, digest=None, filename="kurisu.vrm"):
    return client.put(
        f"/character-assets/{persona_id}/vrm/model",
        params={"sha256": digest or sha(data), "filename": filename},
        content=data,
    )


def put_clip(client, data, persona_id=PERSONA, name="wave", loop=False):
    return client.put(
        f"/character-assets/{persona_id}/vrma",
        params={"sha256": sha(data), "name": name, "loop": str(loop).lower()},
        content=data,
    )


def incoming(tmp_path, persona_id=PERSONA):
    directory = tmp_path / str(persona_id) / ".incoming"
    return sorted(p.name for p in directory.iterdir()) if directory.exists() else []


def model_file(tmp_path, data, persona_id=PERSONA):
    """Where a model with these bytes is stored: content-addressed by its sha."""
    return tmp_path / str(persona_id) / "vrm" / f"{sha(data)}.vrm"


def model_files(tmp_path, persona_id=PERSONA):
    directory = tmp_path / str(persona_id) / "vrm"
    return sorted(p.name for p in directory.iterdir()) if directory.exists() else []


# ── model upload ────────────────────────────────────────────────────────────


class TestModelUpload:
    def test_a_vrm_1_model_is_stored_and_its_ref_written(self, client, tmp_path):
        data = vrm1()
        response = put_model(client, data)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["sha256"] == sha(data)
        assert body["bytes"] == len(data)
        assert body["model_url"] == f"/character-assets/{PERSONA}/vrm/model"
        assert body["meta"]["spec_version"] == "1.0"
        assert body["meta"]["title"] == "Kurisu"
        assert model_file(tmp_path, data).read_bytes() == data
        assert model_files(tmp_path) == [f"{sha(data)}.vrm"]
        assert incoming(tmp_path) == []

        ref = persona().character_config["vrm"]["model"]
        assert ref["sha256"] == sha(data)
        assert ref["filename"] == "kurisu.vrm"
        assert ref["spec_version"] == "1.0"
        assert ref["expressions"] == ["neutral", "happy", "angry", "sad", "relaxed", "surprised"]
        assert body["character_config"] == persona().character_config

    def test_uploading_does_not_change_which_system_shows(self, client):
        assert put_model(client, vrm1()).status_code == 200
        assert persona().character_config["kind"] == "pose_graph"
        assert "pose_tree" in persona().character_config

    def test_a_persona_with_no_config_gets_a_vrm_member(self, client):
        assert put_model(client, vrm1(), persona_id=OTHER_PERSONA).status_code == 200
        config = persona(OTHER_PERSONA).character_config
        assert config["kind"] == "vrm"
        assert config["vrm"]["model"]["url"] == f"/character-assets/{OTHER_PERSONA}/vrm/model"
        assert config["vrm"]["idle"]["breath_period_ms"] == 4000

    def test_a_vrm_0_model_reports_its_version_and_has_no_surprised(self, client):
        response = put_model(client, vrm0())
        assert response.status_code == 200, response.text
        ref = persona().character_config["vrm"]["model"]
        assert ref["spec_version"] == "0.x"
        assert "surprised" not in ref["expressions"]
        assert set(ref["expressions"]) == {"neutral", "happy", "angry", "sad", "relaxed"}
        assert response.json()["meta"]["license_name"] == "CC0"

    def test_replacing_keeps_the_settings(self, client):
        put_model(client, vrm1())
        persona().character_config["vrm"]["camera"]["background"] = "#1E2230"
        second = vrm1(presets=("happy",))
        assert put_model(client, second).status_code == 200
        vrm = persona().character_config["vrm"]
        assert vrm["model"]["sha256"] == sha(second)
        assert vrm["camera"]["background"] == "#1E2230"

    def test_someone_elses_persona_is_404_and_nothing_is_written(self, client, tmp_path):
        response = put_model(client, vrm1(), persona_id=9)
        assert response.status_code == 404
        assert not (tmp_path / "9").exists()

    def test_meta_strings_are_truncated(self, client):
        response = put_model(client, vrm1(name="x" * 10_000))
        assert response.status_code == 200
        assert len(response.json()["meta"]["title"]) == assets.META_MAX_CHARS


class TestModelRefusals:
    """Every refusal leaves nothing in ``.incoming``, nothing moved, no ref written."""

    def _assert_untouched(self, tmp_path):
        assert incoming(tmp_path) == []
        assert model_files(tmp_path) == []
        assert "vrm" not in (persona().character_config or {})

    @pytest.mark.parametrize(
        "data, code",
        [
            pytest.param(b"\x89PNG\r\n\x1a\n" + b"0" * 64, "not_glb", id="png"),
            pytest.param(b"PK\x03\x04" + b"0" * 64, "not_glb", id="zip"),
            pytest.param(glb({"asset": {}}, version=1), "not_glb", id="gltf-1"),
            pytest.param(glb({"asset": {"version": "2.0"}}), "not_vrm", id="plain-glb"),
            pytest.param(vrm1(hips=False), "no_humanoid", id="vrm1-no-hips"),
            pytest.param(vrm0(hips=False), "no_humanoid", id="vrm0-no-hips"),
            pytest.param(glb({"asset": {}}, declared_json_len=10_000), "bad_json", id="chunk-longer-than-file"),
            pytest.param(glb(b"{" * 10 + b"not json"), "bad_json", id="not-json"),
            pytest.param(glb(b"[" * 100_000 + b"]" * 100_000), "bad_json", id="deep-nesting"),
            pytest.param(glb(b'"\xff\xfe"'), "bad_json", id="not-utf8"),
        ],
    )
    def test_is_415_with_a_code(self, client, tmp_path, data, code):
        response = put_model(client, data)
        assert response.status_code == 415, response.text
        assert response.json()["detail"]["code"] == code
        self._assert_untouched(tmp_path)

    def test_a_json_chunk_over_the_ceiling_is_415(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(assets, "JSON_MAX_BYTES", 64)
        response = put_model(client, vrm1())
        assert response.status_code == 415
        assert response.json()["detail"]["code"] == "bad_json"
        self._assert_untouched(tmp_path)

    def test_a_mismatched_digest_is_400_and_nothing_is_moved(self, client, tmp_path):
        response = put_model(client, vrm1(), digest="0" * 64)
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "digest_mismatch"
        self._assert_untouched(tmp_path)

    def test_a_missing_digest_is_refused(self, client, tmp_path):
        response = client.put(f"/character-assets/{PERSONA}/vrm/model", content=vrm1())
        assert response.status_code == 422
        self._assert_untouched(tmp_path)

    def test_one_byte_over_the_ceiling_is_413(self, client, tmp_path, monkeypatch):
        data = vrm1()
        monkeypatch.setattr(assets, "MODEL_MAX_BYTES", len(data) - 1)
        response = put_model(client, data)
        assert response.status_code == 413
        assert response.json()["detail"] == {
            "code": "too_large", "message": response.json()["detail"]["message"], "max_bytes": len(data) - 1,
        }
        self._assert_untouched(tmp_path)

    def test_exactly_the_ceiling_is_accepted(self, client, monkeypatch):
        data = vrm1()
        monkeypatch.setattr(assets, "MODEL_MAX_BYTES", len(data))
        assert put_model(client, data).status_code == 200

    def test_over_the_quota_is_507(self, client, tmp_path, monkeypatch):
        data = vrm1()
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(data) - 1)
        response = put_model(client, data)
        assert response.status_code == 507
        assert response.json()["detail"]["code"] == "quota"
        self._assert_untouched(tmp_path)

    def test_replacing_counts_the_old_model_back_in(self, client, monkeypatch):
        data = vrm1()
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(data) + 10)
        assert put_model(client, data).status_code == 200
        # Same size again: fits only because the model it replaces is released.
        assert put_model(client, vrm1(presets=("sad", "happy", "angry", "relaxed", "neutral", "surprised"))).status_code == 200


class TestConcurrentUploadsAndTheQuota:
    async def test_two_uploads_that_fit_alone_but_not_together(self, app, tmp_path, monkeypatch):
        """Both pass the advisory check before either is recorded; exactly one lands."""
        first, second = vrm1(), vrm1(presets=("happy",))
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(first) + len(second) - 1)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            async def upload(persona_id, data):
                return await client.put(
                    f"/character-assets/{persona_id}/vrm/model",
                    params={"sha256": sha(data)},
                    content=data,
                )

            responses = await asyncio.gather(upload(PERSONA, first), upload(OTHER_PERSONA, second))
        statuses = sorted(r.status_code for r in responses)
        assert statuses == [200, 507], [r.text for r in responses]
        used, _ = assets.account_usage(FakePersonaRepository.personas[:2])
        assert used <= assets.QUOTA_BYTES
        assert incoming(tmp_path, PERSONA) == [] and incoming(tmp_path, OTHER_PERSONA) == []

    def test_the_binding_check_is_inside_the_write(self, client, tmp_path, monkeypatch):
        """With the advisory check blinded, the transaction still refuses."""
        data = vrm1()
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(data) - 1)

        async def blind(user_id):
            # So much headroom that the stream's own quota check never trips:
            # the only thing left to refuse the upload is the transaction.
            return -(10 ** 12), [], {PERSONA: persona().character_config}

        monkeypatch.setattr(character, "_account_usage", blind)
        response = put_model(client, data)
        assert response.status_code == 507
        assert response.json()["detail"]["code"] == "quota"
        assert "vrm" not in persona().character_config
        assert model_files(tmp_path) == []


class TestServerOwnership:
    def test_a_config_save_with_a_stale_null_model_keeps_the_ref_and_the_file(self, client, tmp_path):
        data = vrm1()
        put_model(client, data)
        stale = {"kind": "vrm", "vrm": {"model": None, "clips": []}}
        response = client.patch(f"/character-assets/{PERSONA}/character-config", json=stale)
        assert response.status_code == 200, response.text
        assert persona().character_config["vrm"]["model"]["sha256"] == sha(data)
        assert model_file(tmp_path, data).read_bytes() == data

    def test_a_config_save_through_the_persona_route_keeps_them_too(self, client, tmp_path):
        data = vrm1()
        put_model(client, data)
        response = client.patch(
            f"/personas/{PERSONA}", json={"character_config": {"kind": "vrm", "vrm": {"model": None}}}
        )
        assert response.status_code == 200, response.text
        assert model_file(tmp_path, data).exists()

    async def test_a_save_committed_before_an_upload_cannot_sweep_its_model(self, app, tmp_path, monkeypatch):
        """The race the persona lock closes.

        A config save commits a config with no model, then sweeps whatever that
        config does not name. An upload whose ref commits after the save — and
        whose file lands before the save's sweep — would have its model swept
        by a reference set computed before it existed. Here the save is held
        between its commit and its sweep while the upload runs.
        """
        paused, release = asyncio.Event(), asyncio.Event()
        real_cleanup = character.cleanup_after_write

        async def held_cleanup(persona_id, referenced):
            paused.set()
            await release.wait()
            await real_cleanup(persona_id, referenced)

        monkeypatch.setattr(character, "cleanup_after_write", held_cleanup)
        data = vrm1()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            save = asyncio.create_task(
                client.patch(f"/character-assets/{PERSONA}/character-config", json={"kind": "vrm", "vrm": {}})
            )
            await paused.wait()
            upload = asyncio.create_task(
                client.put(f"/character-assets/{PERSONA}/vrm/model", params={"sha256": sha(data)}, content=data)
            )
            await asyncio.sleep(0.3)  # every chance for the upload to land before the sweep
            release.set()
            assert (await save).status_code == 200
            uploaded = await upload
        assert uploaded.status_code == 200, uploaded.text
        assert model_file(tmp_path, data).read_bytes() == data
        assert persona().character_config["vrm"]["model"]["sha256"] == sha(data)

    def test_clearing_the_vrm_member_reclaims_its_files(self, client, tmp_path):
        put_model(client, vrm1())
        put_clip(client, vrma())
        response = client.patch(
            f"/character-assets/{PERSONA}/character-config", json={"kind": "pose_graph", "vrm": None}
        )
        assert response.status_code == 200
        assert model_files(tmp_path) == []
        assert not (tmp_path / str(PERSONA) / "vrma").exists()


class TestModelDelete:
    def test_delete_clears_the_ref_then_unlinks(self, client, tmp_path):
        put_model(client, vrm1())
        persona().character_config["vrm"]["emotion"]["intensity"] = 0.5
        response = client.delete(f"/character-assets/{PERSONA}/vrm/model")
        assert response.status_code == 204
        assert persona().character_config["vrm"]["model"] is None
        assert persona().character_config["vrm"]["emotion"]["intensity"] == 0.5
        assert model_files(tmp_path) == []

    def test_delete_with_nothing_there_is_204(self, client):
        assert client.delete(f"/character-assets/{PERSONA}/vrm/model").status_code == 204


# ── clips ───────────────────────────────────────────────────────────────────


class TestClips:
    def test_a_clip_is_stored_with_a_server_generated_id(self, client, tmp_path):
        data = vrma()
        response = put_clip(client, data, name="shy wave", loop=True)
        assert response.status_code == 200, response.text
        clip = response.json()["clip"]
        assert len(clip["id"]) == 8 and all(c in "0123456789abcdef" for c in clip["id"])
        assert clip["name"] == "shy wave" and clip["loop"] is True
        assert clip["url"] == f"/character-assets/{PERSONA}/vrma/{clip['id']}"
        assert (tmp_path / str(PERSONA) / "vrma" / f"{clip['id']}.vrma").read_bytes() == data
        assert persona().character_config["vrm"]["clips"] == [clip]

    def test_a_model_is_not_a_clip(self, client, tmp_path):
        response = put_clip(client, vrm1())
        assert response.status_code == 415
        assert response.json()["detail"]["code"] == "not_vrma"
        assert incoming(tmp_path) == []

    def test_one_byte_over_the_clip_ceiling_is_413(self, client, monkeypatch):
        data = vrma()
        monkeypatch.setattr(assets, "CLIP_MAX_BYTES", len(data) - 1)
        response = put_clip(client, data)
        assert response.status_code == 413
        assert response.json()["detail"]["code"] == "too_large"

    def test_rename_and_loop(self, client):
        clip = put_clip(client, vrma()).json()["clip"]
        response = client.patch(
            f"/character-assets/{PERSONA}/vrma/{clip['id']}", json={"name": "bow", "loop": True}
        )
        assert response.status_code == 200
        assert response.json()["clip"]["name"] == "bow"
        assert persona().character_config["vrm"]["clips"][0]["loop"] is True

    def test_patch_of_an_unknown_clip_is_404(self, client):
        put_clip(client, vrma())
        assert client.patch(f"/character-assets/{PERSONA}/vrma/deadbeef", json={"name": "x"}).status_code == 404

    def test_a_clip_the_idle_rotation_plays_cannot_be_deleted(self, client, tmp_path):
        clip = put_clip(client, vrma()).json()["clip"]
        persona().character_config["vrm"]["idle"]["idle_clip_ids"] = [clip["id"]]
        response = client.delete(f"/character-assets/{PERSONA}/vrma/{clip['id']}")
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "clip_in_use"
        assert (tmp_path / str(PERSONA) / "vrma" / f"{clip['id']}.vrma").exists()

    def test_a_clip_a_reaction_plays_cannot_be_deleted(self, client):
        clip = put_clip(client, vrma()).json()["clip"]
        persona().character_config["vrm"]["reactions"] = [
            {"id": "r1", "name": "", "when": [], "play": {"type": "clip", "clip_id": clip["id"]}, "cooldown_ms": 4000}
        ]
        assert client.delete(f"/character-assets/{PERSONA}/vrma/{clip['id']}").status_code == 409

    def test_delete_removes_the_ref_then_the_file(self, client, tmp_path):
        clip = put_clip(client, vrma()).json()["clip"]
        assert client.delete(f"/character-assets/{PERSONA}/vrma/{clip['id']}").status_code == 204
        assert persona().character_config["vrm"]["clips"] == []
        assert not (tmp_path / str(PERSONA) / "vrma" / f"{clip['id']}.vrma").exists()

    @pytest.mark.parametrize("clip_id", ["ABCDEF12", "abc", "abcdef123"])
    def test_a_clip_id_that_is_not_eight_lowercase_hex_is_400(self, client, clip_id):
        """Each of these reaches the clip routes (one path segment) and is refused there."""
        put_clip(client, vrma())
        assert client.get(f"/character-assets/{PERSONA}/vrma/{clip_id}").status_code == 400
        assert client.patch(f"/character-assets/{PERSONA}/vrma/{clip_id}", json={"name": "x"}).status_code == 400
        assert client.delete(f"/character-assets/{PERSONA}/vrma/{clip_id}").status_code == 400


# ── serving ─────────────────────────────────────────────────────────────────


class TestServing:
    def test_the_model_is_served_with_the_stored_etag(self, client):
        data = vrm1()
        put_model(client, data)
        response = client.get(f"/character-assets/{PERSONA}/vrm/model")
        assert response.status_code == 200
        assert response.content == data
        assert response.headers["content-type"] == "model/gltf-binary"
        assert response.headers["etag"] == f'"{sha(data)}"'
        assert response.headers["x-content-type-options"] == "nosniff"
        assert "must-revalidate" in response.headers["cache-control"]

    def test_if_none_match_is_304(self, client):
        data = vrm1()
        put_model(client, data)
        response = client.get(
            f"/character-assets/{PERSONA}/vrm/model", headers={"If-None-Match": f'"{sha(data)}"'}
        )
        assert response.status_code == 304
        assert response.content == b""

    def test_the_etag_and_the_file_both_come_from_the_stored_ref(self, client, tmp_path):
        """The ref's sha picks the file *and* is the ETag, so the two cannot disagree."""
        put_model(client, vrm1())
        stand_in = tmp_path / str(PERSONA) / "vrm" / f"{'a' * 64}.vrm"
        stand_in.write_bytes(b"what the ref now names")
        persona().character_config["vrm"]["model"]["sha256"] = "a" * 64
        response = client.get(f"/character-assets/{PERSONA}/vrm/model")
        assert response.headers["etag"] == f'"{"a" * 64}"'
        assert response.content == b"what the ref now names"

    def test_after_a_replace_the_served_bytes_hash_to_the_etag(self, client, tmp_path):
        """A replaced model is a new file; the old one goes once the new ref is committed."""
        first, second = vrm1(), vrm1(presets=("happy",))
        put_model(client, first)
        assert put_model(client, second).status_code == 200
        response = client.get(f"/character-assets/{PERSONA}/vrm/model")
        assert response.status_code == 200
        assert response.headers["etag"] == f'"{sha(response.content)}"'
        assert response.content == second
        assert model_files(tmp_path) == [f"{sha(second)}.vrm"]

    def test_a_replace_refused_in_the_transaction_leaves_the_old_model_served(self, client, tmp_path, monkeypatch):
        first, second = vrm1(), vrm1(presets=("happy", "sad"))
        put_model(client, first)
        # Room for the stream (the advisory check counts the old model back in)
        # but not for both once the transaction measures.
        async def blind(user_id):
            return -(10 ** 12), [], {PERSONA: persona().character_config}

        monkeypatch.setattr(character, "_account_usage", blind)
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(first) + len(second) - 1)
        persona().character_config["vrm"]["clips"] = [
            {"id": "deadbeef", "name": "x", "url": f"/character-assets/{PERSONA}/vrma/deadbeef",
             "sha256": "b" * 64, "bytes": 10 ** 9, "loop": False}
        ]
        assert put_model(client, second).status_code == 507
        assert model_files(tmp_path) == [f"{sha(first)}.vrm"]
        response = client.get(f"/character-assets/{PERSONA}/vrm/model")
        assert response.content == first and response.headers["etag"] == f'"{sha(first)}"'

    def test_not_shadowed_by_the_pose_route(self, client):
        """The generic pose route has the same shape; it would refuse "vrm" as a pose id."""
        put_model(client, vrm1())
        assert client.get(f"/character-assets/{PERSONA}/vrm/model").status_code == 200

    def test_no_model_is_404(self, client):
        assert client.get(f"/character-assets/{PERSONA}/vrm/model").status_code == 404

    def test_a_ref_whose_file_is_gone_is_404(self, client, tmp_path):
        data = vrm1()
        put_model(client, data)
        model_file(tmp_path, data).unlink()
        assert client.get(f"/character-assets/{PERSONA}/vrm/model").status_code == 404

    def test_a_clip_is_served_with_nosniff(self, client):
        data = vrma()
        clip = put_clip(client, data).json()["clip"]
        response = client.get(f"/character-assets/{PERSONA}/vrma/{clip['id']}")
        assert response.status_code == 200
        assert response.content == data
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["etag"] == f'"{sha(data)}"'

    def test_someone_elses_model_is_404(self, client):
        assert client.get("/character-assets/9/vrm/model").status_code == 404


class TestUsage:
    def test_usage_is_the_sum_of_the_stored_refs(self, client, monkeypatch):
        model, clip = vrm1(), vrma()
        put_model(client, model)
        put_clip(client, clip)
        put_model(client, vrm0(), persona_id=OTHER_PERSONA)
        body = client.get("/character-assets/usage").json()
        assert body["used_bytes"] == len(model) + len(clip) + len(vrm0())
        assert body["quota_bytes"] == assets.QUOTA_BYTES
        assert body["max_model_bytes"] == assets.MODEL_MAX_BYTES
        assert body["max_clip_bytes"] == assets.CLIP_MAX_BYTES
        per = {entry["persona_id"]: entry["bytes"] for entry in body["per_persona"]}
        assert per == {PERSONA: len(model) + len(clip), OTHER_PERSONA: len(vrm0())}

    def test_pose_art_is_not_metered(self, client, tmp_path):
        (tmp_path / str(PERSONA) / "p1").mkdir(parents=True)
        (tmp_path / str(PERSONA) / "p1" / "base.png").write_bytes(b"x" * 1000)
        assert client.get("/character-assets/usage").json()["used_bytes"] == 0


# ── streaming, part-files, hang-ups ─────────────────────────────────────────


class TestStreaming:
    def test_a_stale_part_file_is_swept_by_the_next_upload(self, client, tmp_path):
        directory = tmp_path / str(PERSONA) / ".incoming"
        directory.mkdir(parents=True)
        stale, fresh = directory / "stale", directory / "fresh"
        stale.write_bytes(b"x")
        fresh.write_bytes(b"x")
        old = time.time() - blob_stream.INCOMING_MAX_AGE_SECONDS - 60
        os.utime(stale, (old, old))
        put_model(client, vrm1())
        assert not stale.exists()
        assert fresh.exists()

    async def test_a_hang_up_mid_stream_leaves_nothing(self, tmp_path):
        async def breaks():
            yield b"glTF"
            raise asyncio.CancelledError()

        target = tmp_path / ".incoming" / "part"
        with pytest.raises(asyncio.CancelledError):
            await blob_stream.write_stream(
                target, breaks(), 1_000, 1_000,
                too_large=lambda: RuntimeError(), over_quota=lambda: RuntimeError(),
            )
        assert not target.exists()

    def test_the_drive_still_streams_through_the_shared_core(self):
        """``store_stream`` is the drive's; ``write_stream`` is what both stores run."""
        source = inspect.getsource(drive_storage.store_stream)
        assert "write_stream(" in source
        assert drive_storage.INCOMING_MAX_AGE_SECONDS == blob_stream.INCOMING_MAX_AGE_SECONDS


class TestPersonaDeletedMidUpload:
    def test_the_part_file_vanishing_under_validation_is_404(self, client, monkeypatch):
        """A persona delete removes the directory, part-file included, while the bytes arrive."""
        def gone(path):
            raise FileNotFoundError(path)

        monkeypatch.setattr(assets, "inspect_model_file", gone)
        response = put_model(client, vrm1())
        assert response.status_code == 404

    def test_no_incoming_is_created_for_a_persona_gone_since_the_ownership_check(self, client, tmp_path, monkeypatch):
        real = character._require_persona

        async def then_deleted(user_id, persona_id):
            config = await real(user_id, persona_id)
            FakePersonaRepository.personas = [p for p in FakePersonaRepository.personas if p.id != persona_id]
            return config

        monkeypatch.setattr(character, "_require_persona", then_deleted)
        response = put_model(client, vrm1())
        assert response.status_code == 404
        assert not (tmp_path / str(PERSONA) / ".incoming").exists()


class TestValidationStaysOffTheLoop:
    """The JSON chunk is parsed in a worker thread, never on the event loop."""

    BLOCKING = {"inspect_model_file", "inspect_clip_file", "read_glb_json", "inspect_model"}

    def test_the_router_only_calls_validation_through_a_thread(self):
        tree = ast.parse(inspect.getsource(character))
        offenders = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
                if name in self.BLOCKING:
                    offenders.append(name)
        assert offenders == [], f"validation called directly on the loop: {offenders}"
        source = inspect.getsource(character)
        assert "anyio.to_thread.run_sync(assets.inspect_model_file" in source
        assert "anyio.to_thread.run_sync(assets.inspect_clip_file" in source


class TestBoundedPoseUploads:
    """The three pose-graph upload routes read at most their ceiling plus one byte."""

    def test_an_image_over_the_ceiling_is_413(self, client, monkeypatch):
        monkeypatch.setattr(assets, "IMAGE_MAX_BYTES", 16)
        response = client.post(
            "/character-assets/upload-base",
            params={"persona_id": PERSONA, "pose_id": "p1"},
            files={"file": ("a.png", b"x" * 17, "image/png")},
        )
        assert response.status_code == 413
        assert response.json()["detail"]["code"] == "too_large"

    def test_a_video_over_the_ceiling_is_413_and_the_old_one_stays(self, client, tmp_path, monkeypatch):
        edges = tmp_path / str(PERSONA) / "edges"
        edges.mkdir(parents=True)
        (edges / "e1.webm").write_bytes(b"old")
        monkeypatch.setattr(assets, "VIDEO_MAX_BYTES", 16)
        response = client.post(
            "/character-assets/upload-video",
            params={"persona_id": PERSONA, "edge_id": "e1"},
            files={"file": ("a.mp4", b"x" * 17, "video/mp4")},
        )
        assert response.status_code == 413
        assert (edges / "e1.webm").read_bytes() == b"old"
