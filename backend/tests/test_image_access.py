"""Who may fetch an image, over the real app and a real database.

`GET /images/{uuid}` was public — the handler's docstring said "Serve image
publicly" — so every account avatar, persona avatar and face photo was one UUID
away from anybody who could reach the port. UUIDs are not secrets: they are
handed out in API responses, logged by any proxy, and kept in browser history
(#154).

These are system tests rather than unit tests because the thing under test is
the *combination* of the token check and the ownership check, and because the
ownership half reads three different tables.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one).
"""

import cv2
import numpy as np
import pytest

from tests.conftest import (
    SYSTEM_TEST_PASSWORD,
    SYSTEM_TEST_USER,
    _create_activated_user,
)

from kurisuassistant.version import WIRE_PROTOCOL

pytestmark = pytest.mark.db

OTHER_USER = "intruder"
OTHER_PASSWORD = "intruder-password"


def _auth(client, username, password):
    resp = client.post("/login", data={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return token, {
        "Authorization": f"Bearer {token}",
        "X-Wire-Protocol": str(WIRE_PROTOCOL),
    }


@pytest.fixture(scope="module")
def owner(system_client):
    """The account that owns the images under test."""
    return _auth(system_client, SYSTEM_TEST_USER, SYSTEM_TEST_PASSWORD)


@pytest.fixture(scope="module")
def intruder(system_client):
    """A second, fully legitimate account. It simply owns none of these images."""
    try:
        _create_activated_user(OTHER_USER, OTHER_PASSWORD)
    except Exception:
        pass  # module-scoped; already created by an earlier run in this session
    return _auth(system_client, OTHER_USER, OTHER_PASSWORD)


def _jpeg_bytes(shade: int = 128) -> bytes:
    """A real, decodable JPEG — the upload path decodes before it stores."""
    ok, buf = cv2.imencode(".jpg", np.full((8, 8, 3), shade, dtype=np.uint8))
    assert ok
    return buf.tobytes()


def _upload(client, headers, shade: int = 128) -> str:
    resp = client.post(
        "/images",
        files={"file": ("a.jpg", _jpeg_bytes(shade), "image/jpeg")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["image_uuid"]


class TestUnauthenticated:
    """The defect itself: no token, no image."""

    def test_no_token_is_refused(self, system_client, owner):
        _, headers = owner
        image_uuid = _upload(system_client, headers)

        resp = system_client.get(f"/images/{image_uuid}")

        assert resp.status_code == 401, (
            "the route used to serve this to anyone who could reach the port"
        )

    def test_a_junk_token_is_refused(self, system_client, owner):
        _, headers = owner
        image_uuid = _upload(system_client, headers)

        assert system_client.get(f"/images/{image_uuid}?token=not-a-jwt").status_code == 401

    def test_an_unknown_uuid_is_still_refused_before_it_is_looked_up(self, system_client):
        """401 before 404: an anonymous caller may not probe which UUIDs exist."""
        resp = system_client.get("/images/2b3c4d5e-0000-0000-0000-000000000000")
        assert resp.status_code == 401


class TestOwnership:
    """A valid token is not enough — it has to be the right account."""

    def test_the_uploader_can_fetch_it(self, system_client, owner):
        token, headers = owner
        image_uuid = _upload(system_client, headers)

        by_query = system_client.get(f"/images/{image_uuid}?token={token}")
        assert by_query.status_code == 200
        assert by_query.headers["content-type"] == "image/jpeg"

    def test_the_header_works_too(self, system_client, owner):
        """Android's Coil runs on the authenticated OkHttp client, so it sends a
        header rather than a query parameter. Both have to work."""
        _, headers = owner
        image_uuid = _upload(system_client, headers)

        assert system_client.get(f"/images/{image_uuid}", headers=headers).status_code == 200

    def test_another_account_gets_404_not_403(self, system_client, owner, intruder):
        """404, because 403 would confirm the UUID names something real."""
        _, owner_headers = owner
        intruder_token, intruder_headers = intruder
        image_uuid = _upload(system_client, owner_headers)

        assert system_client.get(
            f"/images/{image_uuid}?token={intruder_token}"
        ).status_code == 404
        assert system_client.get(
            f"/images/{image_uuid}", headers=intruder_headers
        ).status_code == 404

    def test_a_fresh_upload_is_visible_before_anything_references_it(
        self, system_client, owner,
    ):
        """The persona editor shows an avatar between uploading it and saving the
        persona. Ownership derived only from the referencing row could not answer
        for that image, so the preview would break."""
        token, headers = owner
        image_uuid = _upload(system_client, headers)

        assert system_client.get(f"/images/{image_uuid}?token={token}").status_code == 200

    def test_the_response_is_not_cached_by_shared_caches(self, system_client, owner):
        """The URL is account-scoped now, so a shared cache must not reuse it."""
        token, headers = owner
        image_uuid = _upload(system_client, headers)

        resp = system_client.get(f"/images/{image_uuid}?token={token}")
        assert "private" in resp.headers["cache-control"]
        assert "public" not in resp.headers["cache-control"]


class TestLegacyFlatStore:
    """Images written before #154 sit in a flat directory with no owner on disk.

    Those are the avatars and face photos an existing deployment already has, so
    they have to keep working — for their owner, and only for their owner. The
    referencing row is what settles it.
    """

    @staticmethod
    def _plant_legacy_image(shade: int = 200) -> str:
        """Write straight into the flat store, the way the old code did."""
        import uuid as uuid_mod

        from kurisuassistant.utils.images import IMAGES_DIR

        image_uuid = str(uuid_mod.uuid4())
        cv2.imwrite(
            str(IMAGES_DIR / f"{image_uuid}.jpg"),
            np.full((8, 8, 3), shade, dtype=np.uint8),
        )
        return image_uuid

    @staticmethod
    def _attach_behind_the_api(persona_id: int, image_uuid: str) -> None:
        """Point a persona at a flat-store image the way a pre-#154 row does.

        Not through ``PATCH /personas``: attaching an image you do not own is
        exactly what that route now refuses, and this is modelling data that was
        already on disk before it started refusing.
        """
        from kurisuassistant.db.models import Persona
        from kurisuassistant.db.session import get_session

        with get_session() as session:
            persona = session.query(Persona).filter(Persona.id == persona_id).one()
            persona.avatar_uuid = image_uuid

    def test_a_persona_avatar_is_served_to_its_owner(self, system_client, owner, intruder):
        token, headers = owner
        intruder_token, _ = intruder
        image_uuid = self._plant_legacy_image()

        personas = system_client.get("/personas", headers=headers).json()
        self._attach_behind_the_api(personas[0]["id"], image_uuid)

        assert system_client.get(f"/images/{image_uuid}?token={token}").status_code == 200
        assert system_client.get(
            f"/images/{image_uuid}?token={intruder_token}"
        ).status_code == 404, "a legacy image is still only its owner's"

    def test_an_orphan_in_the_flat_store_is_served_to_nobody(
        self, system_client, owner, intruder,
    ):
        """Nothing references it — a leftover from a deleted persona, say. It is
        not the caller's just because they are signed in."""
        token, _ = owner
        intruder_token, _ = intruder
        image_uuid = self._plant_legacy_image(shade=64)

        assert system_client.get(f"/images/{image_uuid}?token={token}").status_code == 404
        assert system_client.get(
            f"/images/{image_uuid}?token={intruder_token}"
        ).status_code == 404

class TestAttachingSomebodyElsesImage:
    """The read check alone would be a lock whose key the attacker can cut.

    ``personas.avatar_uuid`` is a free-form string. If ownership were only ever
    tested when fetching — "does a row you own reference this UUID?" — then
    anyone who learned a UUID from a proxy log, a screenshot or a shared browser
    could point their own persona at it and fetch it perfectly legitimately. So
    the UUID has to be theirs before they may attach it.
    """

    def test_it_cannot_be_attached_to_a_persona(self, system_client, owner, intruder):
        _, owner_headers = owner
        intruder_token, intruder_headers = intruder
        victim_uuid = _upload(system_client, owner_headers)

        personas = system_client.get("/personas", headers=intruder_headers).json()
        resp = system_client.patch(
            f"/personas/{personas[0]['id']}",
            json={"avatar_uuid": victim_uuid},
            headers=intruder_headers,
        )

        assert resp.status_code == 400, "the attach is where this has to be stopped"
        assert system_client.get(
            f"/images/{victim_uuid}?token={intruder_token}"
        ).status_code == 404, "and it did not become theirs by asking"

    def test_it_cannot_be_attached_to_a_new_persona_either(
        self, system_client, owner, intruder,
    ):
        _, owner_headers = owner
        _, intruder_headers = intruder
        victim_uuid = _upload(system_client, owner_headers)

        resp = system_client.post(
            "/personas",
            json={"name": "Borrowed face", "avatar_uuid": victim_uuid},
            headers=intruder_headers,
        )
        assert resp.status_code == 400

    def test_your_own_image_still_attaches(self, system_client, intruder):
        """The guard must not stand in the way of the ordinary case."""
        intruder_token, intruder_headers = intruder
        own_uuid = _upload(system_client, intruder_headers, shade=32)

        personas = system_client.get("/personas", headers=intruder_headers).json()
        resp = system_client.patch(
            f"/personas/{personas[0]['id']}",
            json={"avatar_uuid": own_uuid},
            headers=intruder_headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["avatar_uuid"] == own_uuid
        assert system_client.get(f"/images/{own_uuid}?token={intruder_token}").status_code == 200

    def test_clearing_an_avatar_is_not_blocked(self, system_client, intruder):
        _, intruder_headers = intruder
        personas = system_client.get("/personas", headers=intruder_headers).json()
        resp = system_client.patch(
            f"/personas/{personas[0]['id']}", json={"avatar_uuid": None}, headers=intruder_headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["avatar_uuid"] is None
