"""Kurisu Drive over the real app and a real database (#17).

What is under test here is the *combination* the drive is made of: a row that
owns a blob, an account that owns the row, and a serving route that must not
hand either to anyone else. Unit tests over the validators live in
``test_drive_router.py``; these are the ones that would have caught a real leak.

Every test points ``drive_storage.DRIVE_DIR`` at a temporary directory, so the
suite never writes into the repository's own ``data/``.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one).
"""

import pytest

from tests.conftest import (
    SYSTEM_TEST_PASSWORD,
    SYSTEM_TEST_USER,
    _create_activated_user,
)

from kurisuassistant.version import WIRE_PROTOCOL

pytestmark = pytest.mark.db

OTHER_USER = "drive-intruder"
OTHER_PASSWORD = "drive-intruder-password"


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
    return _auth(system_client, SYSTEM_TEST_USER, SYSTEM_TEST_PASSWORD)


@pytest.fixture(scope="module")
def intruder(system_client):
    """A second, entirely legitimate account. It simply owns none of this."""
    try:
        _create_activated_user(OTHER_USER, OTHER_PASSWORD)
    except Exception:
        pass  # module-scoped; an earlier module in this session may have made it
    return _auth(system_client, OTHER_USER, OTHER_PASSWORD)


@pytest.fixture(autouse=True)
def drive_root(tmp_path, monkeypatch):
    """Keep every blob this suite writes inside pytest's temporary directory."""
    from kurisuassistant.utils import drive_storage

    monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path / "drive")
    return tmp_path / "drive"


def _upload(client, headers, name, data, parent_id=None, overwrite=False):
    """Upload is a raw body with the destination in the query string.

    Not multipart: a handler declaring an ``UploadFile`` makes FastAPI parse and
    spool the whole body *before* it resolves dependencies, so the bytes would
    land on the server's disk before the auth check, the size ceiling and the
    quota ever ran.
    """
    params = {"name": name}
    if parent_id is not None:
        params["parent_id"] = str(parent_id)
    if overwrite:
        params["overwrite"] = "true"
    return client.post("/drive/files", params=params, content=data, headers=headers)


def _folder(client, headers, name, parent_id=None):
    resp = client.post(
        "/drive/folders", json={"name": name, "parent_id": parent_id}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestUnauthenticated:
    """No token, no drive. The whole point is that files belong to an account."""

    @pytest.mark.parametrize(
        "method,path",
        [
            ("get", "/drive/nodes"),
            ("get", "/drive/usage"),
            ("get", "/drive/resolve?path=/x"),
            ("post", "/drive/folders"),
            ("post", "/drive/files?name=x.txt"),
        ],
    )
    def test_no_token_is_refused(self, system_client, method, path):
        resp = getattr(system_client, method)(
            path, headers={"X-Wire-Protocol": str(WIRE_PROTOCOL)}
        )
        assert resp.status_code == 401

    def test_download_without_a_token_is_refused(self, system_client, owner):
        _, headers = owner
        node = _upload(system_client, headers, "private.txt", b"secret").json()
        resp = system_client.get(
            f"/drive/files/{node['id']}/content",
            headers={"X-Wire-Protocol": str(WIRE_PROTOCOL)},
        )
        assert resp.status_code == 401

    def test_a_bad_query_token_is_refused(self, system_client, owner):
        _, headers = owner
        node = _upload(system_client, headers, "private2.txt", b"secret").json()
        resp = system_client.get(
            f"/drive/files/{node['id']}/content?token=not-a-real-token",
            headers={"X-Wire-Protocol": str(WIRE_PROTOCOL)},
        )
        assert resp.status_code == 401


class TestTheBodyIsNotReadBeforeTheCallerIs:
    """An upload must not cost the server anything before it is authenticated.

    A handler declaring ``UploadFile`` makes FastAPI call ``request.form()``
    before ``solve_dependencies``, so the whole body is parsed and spooled to
    disk before ``get_authenticated_user`` runs — an unauthenticated caller
    could push whatever the proxy allows onto the server's filesystem and only
    then be told 401. The route takes a raw stream instead.
    """

    def test_the_route_declares_no_body_field(self):
        """The property, checked where it is decided rather than inferred.

        FastAPI pre-reads exactly when a handler has a body parameter. Nothing
        observable from the outside distinguishes "refused after reading" from
        "refused before", so the signature is the thing to pin.
        """
        import inspect

        from kurisuassistant.routers import drive as drive_router

        signature = inspect.signature(drive_router.upload_file)
        annotations = [p.annotation for p in signature.parameters.values()]
        rendered = [str(a) for a in annotations]
        assert not any("UploadFile" in r for r in rendered), rendered
        assert any("Request" in r for r in rendered), rendered

    def test_an_unauthenticated_upload_is_refused(self, system_client, drive_root):
        resp = system_client.post(
            "/drive/files",
            params={"name": "sneaky.bin"},
            content=b"x" * 1024,
            headers={"X-Wire-Protocol": str(WIRE_PROTOCOL)},
        )
        assert resp.status_code == 401
        assert not [p for p in drive_root.rglob("*") if p.is_file()]


class TestRoundTrip:
    """The thing the issue actually asks for: put a file in, get it back
    unchanged."""

    def test_bytes_come_back_identical(self, system_client, owner):
        _, headers = owner
        # Deliberately not text and not valid UTF-8: every other upload route in
        # this backend re-encodes what it stores, and the drive must not.
        payload = bytes(range(256)) * 40
        node = _upload(system_client, headers, "raw.bin", payload).json()
        assert node["size"] == len(payload)

        resp = system_client.get(f"/drive/files/{node['id']}/content", headers=headers)
        assert resp.status_code == 200
        assert resp.content == payload

    def test_checksum_is_the_sha256_of_what_was_stored(self, system_client, owner):
        from hashlib import sha256

        _, headers = owner
        payload = b"the checksum is what lets #6 know the bytes changed"
        node = _upload(system_client, headers, "sums.txt", payload).json()
        assert node["checksum"] == sha256(payload).hexdigest()

    def test_a_download_uses_the_query_token_when_there_is_no_header(
        self, system_client, owner
    ):
        token, headers = owner
        node = _upload(system_client, headers, "by-token.txt", b"hello").json()
        resp = system_client.get(
            f"/drive/files/{node['id']}/content?token={token}",
            headers={"X-Wire-Protocol": str(WIRE_PROTOCOL)},
        )
        assert resp.status_code == 200
        assert resp.content == b"hello"


class TestServingIsDefensive:
    """A drive stores whatever it is given, which is exactly why serving it back
    has to be careful."""

    def test_a_download_is_an_attachment_and_is_not_sniffed(self, system_client, owner):
        _, headers = owner
        node = _upload(system_client, headers, "notes.txt", b"plain").json()
        resp = system_client.get(f"/drive/files/{node['id']}/content", headers=headers)
        assert "attachment" in resp.headers["content-disposition"]
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["content-type"].startswith("application/octet-stream")

    def test_inline_is_honoured_for_a_type_that_cannot_execute(
        self, system_client, owner
    ):
        _, headers = owner
        node = _upload(system_client, headers, "inline-me.txt", b"plain").json()
        resp = system_client.get(
            f"/drive/files/{node['id']}/content?inline=1", headers=headers
        )
        assert "inline" in resp.headers["content-disposition"]
        assert resp.headers["content-type"].startswith("text/plain")

    @pytest.mark.parametrize(
        "name,body",
        [
            ("payload.html", b"<script>alert(1)</script>"),
            # SVG is an image the browser executes; it is the case the
            # "image/*" allowance would otherwise wave straight through.
            ("payload.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
        ],
    )
    def test_inline_is_refused_for_anything_that_runs(
        self, system_client, owner, name, body
    ):
        """An uploaded page served inline would run on the API's own origin,
        with the caller's session behind it."""
        _, headers = owner
        node = _upload(system_client, headers, name, body).json()
        resp = system_client.get(
            f"/drive/files/{node['id']}/content?inline=1", headers=headers
        )
        assert "attachment" in resp.headers["content-disposition"]
        assert resp.headers["content-type"].startswith("application/octet-stream")

    def test_a_range_request_is_answered_with_206(self, system_client, owner):
        """Serving through FileResponse is what makes seeking in a long voice
        memo work; a hand-rolled read would have to reimplement it."""
        _, headers = owner
        payload = b"0123456789" * 100
        node = _upload(system_client, headers, "seekable.bin", payload).json()
        resp = system_client.get(
            f"/drive/files/{node['id']}/content",
            headers={**headers, "Range": "bytes=10-19"},
        )
        assert resp.status_code == 206
        assert resp.content == b"0123456789"


class TestNamesAndTree:
    def test_a_folder_holds_its_children(self, system_client, owner):
        _, headers = owner
        folder = _folder(system_client, headers, "Reports")
        _upload(system_client, headers, "q3.md", b"# Q3", parent_id=folder["id"])

        resp = system_client.get(
            f"/drive/nodes?parent_id={folder['id']}", headers=headers
        )
        assert resp.status_code == 200
        assert [n["name"] for n in resp.json()] == ["q3.md"]

    def test_a_path_resolves_to_the_node_it_names(self, system_client, owner):
        _, headers = owner
        folder = _folder(system_client, headers, "Resolvable")
        node = _upload(
            system_client, headers, "deep.md", b"x", parent_id=folder["id"]
        ).json()

        resp = system_client.get(
            "/drive/resolve", params={"path": "/Resolvable/deep.md"}, headers=headers
        )
        assert resp.status_code == 200
        assert resp.json()["id"] == node["id"]

    def test_a_traversal_path_resolves_to_nothing(self, system_client, owner):
        """`..` is matched against stored names like any other segment, so it
        simply does not exist. There is no filesystem to escape from."""
        _, headers = owner
        _folder(system_client, headers, "Escapable")
        resp = system_client.get(
            "/drive/resolve",
            params={"path": "/Escapable/../../../etc/passwd"},
            headers=headers,
        )
        assert resp.status_code == 404

    @pytest.mark.parametrize(
        "name", ["", "   ", "..", ".", "a/b", "a\\b", " leading", "trailing ", "x" * 300]
    )
    def test_a_name_that_would_look_like_a_path_is_refused(
        self, system_client, owner, name
    ):
        _, headers = owner
        resp = system_client.post(
            "/drive/folders", json={"name": name, "parent_id": None}, headers=headers
        )
        assert resp.status_code == 400, resp.text

    def test_a_duplicate_name_is_refused(self, system_client, owner):
        _, headers = owner
        folder = _folder(system_client, headers, "Dupes")
        assert _upload(
            system_client, headers, "same.txt", b"one", parent_id=folder["id"]
        ).status_code == 200
        clash = _upload(
            system_client, headers, "same.txt", b"two", parent_id=folder["id"]
        )
        assert clash.status_code == 409

    def test_overwrite_replaces_the_bytes_and_releases_the_old_blob(
        self, system_client, owner, drive_root
    ):
        _, headers = owner
        folder = _folder(system_client, headers, "Overwrites")
        first = _upload(
            system_client, headers, "same.txt", b"one", parent_id=folder["id"]
        ).json()
        blobs_before = set(p.name for p in (drive_root).rglob("*") if p.is_file())

        second = _upload(
            system_client,
            headers,
            "same.txt",
            b"two-and-longer",
            parent_id=folder["id"],
            overwrite=True,
        )
        assert second.status_code == 200, second.text
        assert second.json()["id"] == first["id"]

        resp = system_client.get(f"/drive/files/{first['id']}/content", headers=headers)
        assert resp.content == b"two-and-longer"

        blobs_after = set(p.name for p in (drive_root).rglob("*") if p.is_file())
        # The replaced file's bytes are gone, not merely unreferenced.
        assert not (blobs_before & blobs_after)

    def test_rename_and_move(self, system_client, owner):
        _, headers = owner
        source = _folder(system_client, headers, "MoveFrom")
        target = _folder(system_client, headers, "MoveTo")
        node = _upload(
            system_client, headers, "wander.txt", b"x", parent_id=source["id"]
        ).json()

        resp = system_client.patch(
            f"/drive/nodes/{node['id']}",
            json={"name": "settled.txt", "parent_id": target["id"]},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "settled.txt"
        assert resp.json()["parent_id"] == target["id"]

        listing = system_client.get(
            f"/drive/nodes?parent_id={source['id']}", headers=headers
        ).json()
        assert listing == []

    def test_a_folder_cannot_be_moved_into_itself(self, system_client, owner):
        _, headers = owner
        outer = _folder(system_client, headers, "Outer")
        inner = _folder(system_client, headers, "Inner", parent_id=outer["id"])

        resp = system_client.patch(
            f"/drive/nodes/{outer['id']}",
            json={"parent_id": inner["id"]},
            headers=headers,
        )
        assert resp.status_code == 409, resp.text

    def test_a_rename_onto_a_taken_name_is_refused(self, system_client, owner):
        _, headers = owner
        folder = _folder(system_client, headers, "Collisions")
        _upload(system_client, headers, "taken.txt", b"a", parent_id=folder["id"])
        mover = _upload(
            system_client, headers, "mover.txt", b"b", parent_id=folder["id"]
        ).json()

        resp = system_client.patch(
            f"/drive/nodes/{mover['id']}", json={"name": "taken.txt"}, headers=headers
        )
        assert resp.status_code == 409


class TestDelete:
    def test_deleting_a_file_removes_its_bytes(self, system_client, owner, drive_root):
        _, headers = owner
        node = _upload(system_client, headers, "ephemeral.txt", b"gone soon").json()
        blobs = [p for p in drive_root.rglob("*") if p.is_file()]
        assert blobs

        resp = system_client.delete(f"/drive/nodes/{node['id']}", headers=headers)
        assert resp.status_code == 200

        assert system_client.get(
            f"/drive/nodes/{node['id']}", headers=headers
        ).status_code == 404
        assert not [p for p in drive_root.rglob("*") if p.is_file()]

    def test_deleting_a_folder_takes_its_subtree(self, system_client, owner, drive_root):
        _, headers = owner
        outer = _folder(system_client, headers, "Doomed")
        inner = _folder(system_client, headers, "Nested", parent_id=outer["id"])
        deep = _upload(
            system_client, headers, "deep.txt", b"bye", parent_id=inner["id"]
        ).json()

        assert system_client.delete(
            f"/drive/nodes/{outer['id']}", headers=headers
        ).status_code == 200

        for node_id in (outer["id"], inner["id"], deep["id"]):
            assert system_client.get(
                f"/drive/nodes/{node_id}", headers=headers
            ).status_code == 404
        assert not [p for p in drive_root.rglob("*") if p.is_file()]


class TestOwnership:
    """Another account's node is 404, never 403: confirming that an id exists is
    the same leak in a smaller envelope."""

    def test_another_account_cannot_read_the_node(self, system_client, owner, intruder):
        _, owner_headers = owner
        _, intruder_headers = intruder
        node = _upload(system_client, owner_headers, "mine.txt", b"mine").json()

        assert system_client.get(
            f"/drive/nodes/{node['id']}", headers=intruder_headers
        ).status_code == 404

    def test_another_account_cannot_download_the_bytes(
        self, system_client, owner, intruder
    ):
        """Refused twice over, deliberately: the row lookup is scoped to the
        caller, and the blob path is built from the caller's own user id, so
        even a row that leaked through would resolve to a file that is not
        there. Removing either check alone leaves this test green — the row
        check is what the other tests in this class pin down."""
        _, owner_headers = owner
        intruder_token, intruder_headers = intruder
        node = _upload(system_client, owner_headers, "mine2.txt", b"mine").json()

        assert system_client.get(
            f"/drive/files/{node['id']}/content", headers=intruder_headers
        ).status_code == 404
        # ...including through the query-token form, which is the one an <img>
        # or a streamed download uses.
        assert system_client.get(
            f"/drive/files/{node['id']}/content?token={intruder_token}",
            headers={"X-Wire-Protocol": str(WIRE_PROTOCOL)},
        ).status_code == 404

    def test_another_account_cannot_rename_or_delete(
        self, system_client, owner, intruder
    ):
        _, owner_headers = owner
        _, intruder_headers = intruder
        node = _upload(system_client, owner_headers, "mine3.txt", b"mine").json()

        assert system_client.patch(
            f"/drive/nodes/{node['id']}", json={"name": "theirs.txt"},
            headers=intruder_headers,
        ).status_code == 404
        assert system_client.delete(
            f"/drive/nodes/{node['id']}", headers=intruder_headers
        ).status_code == 404
        # And the owner still has it.
        assert system_client.get(
            f"/drive/nodes/{node['id']}", headers=owner_headers
        ).status_code == 200

    def test_another_account_cannot_upload_into_the_folder(
        self, system_client, owner, intruder
    ):
        _, owner_headers = owner
        _, intruder_headers = intruder
        folder = _folder(system_client, owner_headers, "NotYours")

        resp = _upload(
            system_client, intruder_headers, "smuggled.txt", b"x",
            parent_id=folder["id"],
        )
        assert resp.status_code == 404

    def test_listings_do_not_cross_accounts(self, system_client, owner, intruder):
        _, owner_headers = owner
        _, intruder_headers = intruder
        _folder(system_client, owner_headers, "OwnerOnly")

        names = [
            n["name"]
            for n in system_client.get("/drive/nodes", headers=intruder_headers).json()
        ]
        assert "OwnerOnly" not in names


class TestLimits:
    def test_a_file_over_the_ceiling_is_refused(self, system_client, owner, monkeypatch):
        from kurisuassistant.utils import drive_storage

        monkeypatch.setattr(drive_storage, "MAX_FILE_BYTES", 64)
        _, headers = owner
        resp = _upload(system_client, headers, "too-big.bin", b"x" * 500)
        assert resp.status_code == 413, resp.text

    def test_a_refused_upload_leaves_nothing_behind(
        self, system_client, owner, monkeypatch, drive_root
    ):
        from kurisuassistant.utils import drive_storage

        monkeypatch.setattr(drive_storage, "MAX_FILE_BYTES", 64)
        _, headers = owner
        _upload(system_client, headers, "too-big2.bin", b"x" * 500)
        assert not [p for p in drive_root.rglob("*") if p.is_file()]

    def test_a_full_drive_is_refused_even_when_it_fills_up_mid_upload(
        self, system_client, owner, monkeypatch, drive_root
    ):
        """The quota is measured before the bytes arrive and nothing reserves
        the space, so the check that has to hold is the one inside the write
        transaction — which runs on the single database thread, and is
        therefore atomic against every other upload."""
        from kurisuassistant.utils import drive_storage

        _, headers = owner
        # Room at the start; none by the time the row is written.
        monkeypatch.setattr(drive_storage, "QUOTA_BYTES", 10_000)
        sizes = iter([0, 10_000])
        real_usage = __import__(
            "kurisuassistant.db.repositories.drive", fromlist=["DriveNodeRepository"]
        ).DriveNodeRepository.usage
        monkeypatch.setattr(
            "kurisuassistant.db.repositories.drive.DriveNodeRepository.usage",
            lambda self, user_id: (next(sizes, 10_000), 0),
        )

        resp = _upload(system_client, headers, "late.bin", b"x" * 100)

        assert resp.status_code == 507, resp.text
        # ...and the bytes it had already written are released.
        assert not [p for p in drive_root.rglob("*") if p.is_file()]
        assert real_usage  # referenced so the patch target is obviously the real one

    def test_a_full_drive_is_refused(self, system_client, owner, monkeypatch):
        from kurisuassistant.utils import drive_storage

        _, headers = owner
        assert _upload(
            system_client, headers, "first.bin", b"x" * 100
        ).status_code == 200

        monkeypatch.setattr(drive_storage, "QUOTA_BYTES", 120)
        resp = _upload(system_client, headers, "second.bin", b"x" * 100)
        assert resp.status_code == 507, resp.text

    def test_usage_counts_files_and_not_folders(self, system_client, owner):
        _, headers = owner
        _folder(system_client, headers, "Weightless")
        _upload(system_client, headers, "weighty.bin", b"x" * 321)

        usage = system_client.get("/drive/usage", headers=headers).json()
        assert usage["used_bytes"] >= 321
        assert usage["file_count"] >= 1
        assert usage["quota_bytes"] > 0


class TestEditorSave:
    def test_put_replaces_the_content_in_place(self, system_client, owner):
        _, headers = owner
        node = _upload(system_client, headers, "editable.md", b"# before").json()

        resp = system_client.put(
            f"/drive/files/{node['id']}/content", content=b"# after", headers=headers
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == node["id"]

        assert system_client.get(
            f"/drive/files/{node['id']}/content", headers=headers
        ).content == b"# after"

    def test_put_on_a_folder_is_refused(self, system_client, owner):
        _, headers = owner
        folder = _folder(system_client, headers, "NotAFile")
        resp = system_client.put(
            f"/drive/files/{folder['id']}/content", content=b"x", headers=headers
        )
        assert resp.status_code == 400
