"""System tests: the 3D character store against a real database (#311).

``test_character_router`` and ``test_character_uploads`` run the routes over a
fake repository; here a model and a clip go through the real app into a real
Postgres and the suite's own data directory (#307), and come back — or are
refused, metered, hidden from another account, and removed with their persona.
"""

import hashlib
import json

import pytest

from tests.conftest import Account, _create_activated_user

pytestmark = pytest.mark.db


def glb(document: dict) -> bytes:
    """A glTF binary whose only chunk is ``document``: all the store inspects."""
    body = json.dumps(document).encode()
    body += b" " * ((4 - len(body) % 4) % 4)
    header = b"glTF" + (2).to_bytes(4, "little") + (12 + 8 + len(body)).to_bytes(4, "little")
    return header + len(body).to_bytes(4, "little") + b"JSON" + body


MODEL = glb({
    "asset": {"version": "2.0"},
    "extensionsUsed": ["VRMC_vrm"],
    "extensions": {"VRMC_vrm": {
        "specVersion": "1.0",
        "meta": {"name": "Test"},
        "humanoid": {"humanBones": {"hips": {"node": 0}}},
        "expressions": {"preset": {"happy": {}, "sad": {}}},
    }},
    "nodes": [{"name": "hips"}],
})
CLIP = glb({"asset": {"version": "2.0"}, "extensionsUsed": ["VRMC_vrm_animation"],
            "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0"}}})
NOT_VRM = glb({"asset": {"version": "2.0"}})


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def put_model(account, persona_id, data=MODEL, digest=None):
    return account.client.put(
        f"/character-assets/{persona_id}/vrm/model",
        params={"sha256": digest or sha(data), "filename": "kurisu.vrm"},
        content=data, headers={**account.headers, "Content-Type": "application/octet-stream"},
    )


def config_of(account, persona_id):
    return account.client.get(f"/personas/{persona_id}", headers=account.headers).json()["character_config"] or {}


@pytest.fixture()
def persona(account):
    resp = account.client.post("/personas", json={"name": "Kurisu", "character_config": {"kind": "vrm"}}, headers=account.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


@pytest.fixture()
def stranger(account):
    name = "stranger-" + account.username
    _create_activated_user(name, "pw")
    return Account(account.client, name, "pw")


def persona_dir(persona_id):
    from kurisuassistant.character import paths

    return paths.CHAR_ASSETS_DIR / str(persona_id)


class TestTheModel:
    def test_an_upload_is_stored_referenced_and_served_back(self, account, persona):
        resp = put_model(account, persona)
        assert resp.status_code == 200, resp.text

        model = config_of(account, persona)["vrm"]["model"]
        assert (model["sha256"], model["bytes"], model["filename"]) == (sha(MODEL), len(MODEL), "kurisu.vrm")
        assert model["url"] == f"/character-assets/{persona}/vrm/model"
        assert set(model["expressions"]) >= {"happy", "sad"}
        assert (persona_dir(persona) / "vrm" / f"{sha(MODEL)}.vrm").read_bytes() == MODEL, "in the suite's own data directory"

        served = account.client.get(model["url"], headers=account.headers)
        assert served.status_code == 200
        assert served.content == MODEL
        assert served.headers["etag"] == f'"{sha(MODEL)}"'
        assert served.headers["x-content-type-options"] == "nosniff"
        again = account.client.get(model["url"], headers={**account.headers, "If-None-Match": served.headers["etag"]})
        assert again.status_code == 304

    def test_a_wrong_digest_or_a_non_vrm_is_refused_and_nothing_is_kept(self, account, persona):
        assert put_model(account, persona, digest="0" * 64).status_code == 400
        refused = put_model(account, persona, data=NOT_VRM)
        assert refused.status_code == 415
        assert "not_vrm" in json.dumps(refused.json())

        assert config_of(account, persona).get("vrm", {}).get("model") is None
        stored = list((persona_dir(persona) / "vrm").glob("*.vrm")) if (persona_dir(persona) / "vrm").exists() else []
        assert stored == []

    def test_the_quota_is_the_accounts_and_is_enforced_in_the_transaction(self, account, persona, monkeypatch):
        from kurisuassistant.character import assets

        assert put_model(account, persona).status_code == 200
        second = account.client.post("/personas", json={"name": "Amadeus", "character_config": {"kind": "vrm"}}, headers=account.headers).json()["id"]
        other_model = MODEL + b" "  # a different file, so it is not the same bytes twice
        monkeypatch.setattr(assets, "QUOTA_BYTES", len(MODEL) + len(other_model) - 1)

        resp = put_model(account, second, data=other_model)
        assert resp.status_code == 507
        assert config_of(account, second).get("vrm", {}).get("model") is None
        usage = account.client.get("/character-assets/usage", headers=account.headers).json()
        assert usage["used_bytes"] == len(MODEL), "the refused upload is not counted"

    def test_another_account_sees_and_touches_nothing(self, account, persona, stranger):
        put_model(account, persona)
        url = f"/character-assets/{persona}/vrm/model"

        assert stranger.client.get(url, headers=stranger.headers).status_code == 404
        assert put_model(stranger, persona).status_code == 404
        assert stranger.client.delete(url, headers=stranger.headers).status_code == 404
        assert account.client.get(url, headers=account.headers).status_code == 200


class TestClipsAndRemoval:
    def test_a_clip_is_stored_and_served_and_the_persona_takes_everything_with_it(self, account, persona):
        put_model(account, persona)
        resp = account.client.put(
            f"/character-assets/{persona}/vrma", params={"sha256": sha(CLIP), "name": "wave"},
            content=CLIP, headers={**account.headers, "Content-Type": "application/octet-stream"},
        )
        assert resp.status_code == 200, resp.text
        clip = config_of(account, persona)["vrm"]["clips"][0]
        assert clip["name"] == "wave"
        assert account.client.get(clip["url"], headers=account.headers).content == CLIP
        assert persona_dir(persona).exists()

        assert account.client.delete(f"/personas/{persona}", headers=account.headers).status_code in (200, 204)

        assert not persona_dir(persona).exists(), "the persona's files go with it"
        assert account.client.get(f"/character-assets/{persona}/vrm/model", headers=account.headers).status_code == 404

    def test_removing_the_model_keeps_the_rest_of_the_character(self, account, persona):
        put_model(account, persona)
        assert account.client.delete(f"/character-assets/{persona}/vrm/model", headers=account.headers).status_code == 204

        config = config_of(account, persona)
        assert config["kind"] == "vrm"
        assert config["vrm"]["model"] is None
        assert not list((persona_dir(persona) / "vrm").glob("*.vrm"))
