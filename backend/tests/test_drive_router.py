"""The drive's validators and blob store, without a database.

These cover the small decisions the system tests take for granted: what may be a
name, what a file's type is taken to be, what may be served inline, and how a
stream that runs over a limit is cleaned up.
"""

import pytest
from fastapi import HTTPException

from kurisuassistant.db.repositories import split_path
from kurisuassistant.utils import drive_storage


class TestValidateName:
    @pytest.mark.parametrize(
        "name",
        ["a", "Q3 revenue notes.md", "résumé.pdf", "with.many.dots.tar.gz", "x" * 255],
    )
    def test_ordinary_names_pass(self, name):
        assert drive_storage.validate_name(name) == name

    @pytest.mark.parametrize(
        "name,reason",
        [
            ("", "empty"),
            ("   ", "whitespace only"),
            (" leading", "leading space"),
            ("trailing ", "trailing space"),
            (".", "current directory"),
            ("..", "parent directory"),
            ("a/b", "posix separator"),
            ("a\\b", "windows separator"),
            ("a\0b", "null byte"),
            ("a\rb", "carriage return — would start a header line"),
            ("a\nb", "line feed — would start a header line"),
            ("a\x7fb", "delete"),
            ("é" * 200, "over 255 bytes once encoded"),
        ],
    )
    def test_names_that_would_look_like_a_path_are_refused(self, name, reason):
        with pytest.raises(HTTPException) as excinfo:
            drive_storage.validate_name(name)
        assert excinfo.value.status_code == 400, reason

    def test_the_message_says_what_is_wrong(self):
        """These reach a user in a dialog, so they have to be readable."""
        with pytest.raises(HTTPException) as excinfo:
            drive_storage.validate_name("a/b")
        assert "slash" in excinfo.value.detail


class TestMime:
    @pytest.mark.parametrize(
        "name,expected",
        [
            ("notes.md", "text/markdown"),
            ("photo.png", "image/png"),
            ("report.pdf", "application/pdf"),
            ("memo.wav", "audio/x-wav"),
        ],
    )
    def test_type_comes_from_the_extension(self, name, expected):
        assert drive_storage.guess_mime(name) == expected

    def test_an_unknown_extension_is_opaque(self):
        assert drive_storage.guess_mime("mystery.qqq") == "application/octet-stream"
        assert drive_storage.guess_mime("no-extension") == "application/octet-stream"


class TestInlineSafety:
    @pytest.mark.parametrize(
        "mime", ["image/png", "audio/x-wav", "video/mp4", "application/pdf", "text/plain"]
    )
    def test_types_that_cannot_execute_may_be_inline(self, mime):
        assert drive_storage.is_inline_safe(mime)

    @pytest.mark.parametrize(
        "mime",
        [
            "text/html",
            "image/svg+xml",  # SVG carries script; it is an image the browser runs
            "application/xhtml+xml",
            "text/markdown",
            "application/octet-stream",
            None,
        ],
    )
    def test_everything_else_is_an_attachment(self, mime):
        assert not drive_storage.is_inline_safe(mime)


class TestSplitPath:
    @pytest.mark.parametrize(
        "path,expected",
        [
            ("/", []),
            ("", []),
            ("/Reports", ["Reports"]),
            ("/Reports/Q3.md", ["Reports", "Q3.md"]),
            ("Reports/Q3.md", ["Reports", "Q3.md"]),
            ("//Reports//Q3.md//", ["Reports", "Q3.md"]),
        ],
    )
    def test_segments(self, path, expected):
        assert split_path(path) == expected

    def test_dot_segments_are_kept_as_names_not_resolved(self):
        """They are matched against stored names, where they do not exist.
        Resolving them would be the start of a traversal bug; leaving them
        alone means there is nothing to traverse."""
        assert split_path("/a/../b") == ["a", "..", "b"]


class TestStoreStream:
    async def _chunks(self, data, size=7):
        for start in range(0, len(data), size):
            yield data[start:start + size]

    async def test_it_writes_the_bytes_and_reports_them(self, tmp_path, monkeypatch):
        from hashlib import sha256

        monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path)
        payload = bytes(range(256))

        key, size, checksum = await drive_storage.store_stream(
            1, self._chunks(payload), quota_remaining=10_000
        )

        assert size == len(payload)
        assert checksum == sha256(payload).hexdigest()
        assert drive_storage.blob_path(1, key).read_bytes() == payload

    async def test_a_file_over_the_ceiling_is_refused_mid_stream(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path)
        monkeypatch.setattr(drive_storage, "MAX_FILE_BYTES", 20)

        with pytest.raises(HTTPException) as excinfo:
            await drive_storage.store_stream(
                1, self._chunks(b"x" * 500), quota_remaining=10_000
            )
        assert excinfo.value.status_code == 413

    async def test_a_full_quota_is_refused_mid_stream(self, tmp_path, monkeypatch):
        monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path)

        with pytest.raises(HTTPException) as excinfo:
            await drive_storage.store_stream(
                1, self._chunks(b"x" * 500), quota_remaining=20
            )
        assert excinfo.value.status_code == 507

    async def test_a_refused_stream_leaves_no_file_behind(self, tmp_path, monkeypatch):
        """The whole point of writing to `.incoming` first: a refused or
        abandoned upload must not leave a partial file for a row to be pointed
        at later."""
        monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path)
        monkeypatch.setattr(drive_storage, "MAX_FILE_BYTES", 20)

        with pytest.raises(HTTPException):
            await drive_storage.store_stream(
                1, self._chunks(b"x" * 500), quota_remaining=10_000
            )

        assert not [p for p in tmp_path.rglob("*") if p.is_file()]

    async def test_a_stream_that_dies_leaves_no_file_behind(self, tmp_path, monkeypatch):
        monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path)

        async def _breaks():
            yield b"some bytes"
            raise ConnectionResetError("client hung up")

        with pytest.raises(ConnectionResetError):
            await drive_storage.store_stream(1, _breaks(), quota_remaining=10_000)

        assert not [p for p in tmp_path.rglob("*") if p.is_file()]


class TestReadText:
    async def _store(self, tmp_path, monkeypatch, payload):
        monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path)

        async def _one():
            yield payload

        key, _, _ = await drive_storage.store_stream(1, _one(), quota_remaining=10_000)
        return key

    async def test_text_comes_back_whole(self, tmp_path, monkeypatch):
        key = await self._store(tmp_path, monkeypatch, "héllo\nworld".encode("utf-8"))
        text, truncated = await drive_storage.read_text(1, key, 1024)
        assert text == "héllo\nworld"
        assert truncated is False

    async def test_a_long_file_is_truncated_and_says_so(self, tmp_path, monkeypatch):
        key = await self._store(tmp_path, monkeypatch, b"abcdefghij")
        text, truncated = await drive_storage.read_text(1, key, 4)
        assert text == "abcd"
        assert truncated is True

    @pytest.mark.parametrize(
        "payload", [b"\x00\x01\x02binary", b"\xff\xfe not utf-8 at all"]
    )
    async def test_binary_is_refused_rather_than_mangled(
        self, tmp_path, monkeypatch, payload
    ):
        key = await self._store(tmp_path, monkeypatch, payload)
        with pytest.raises(ValueError):
            await drive_storage.read_text(1, key, 1024)
