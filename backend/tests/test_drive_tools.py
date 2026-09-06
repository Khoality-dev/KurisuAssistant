"""The assistant's view of the drive: drive_list, drive_read, drive_write, drive_delete.

These run the tools directly, the way ``BaseAgent.execute_tool`` does — with
``user_id`` injected into the arguments rather than declared in the schema, so
the model cannot set it.

The approval gate is not exercised here; it lives in ``agents/base.py`` and has
its own cover in ``test_tool_policy_enforcement.py``. What is tested here is
that the tools refuse what they should before any of that matters, and that they
answer in sentences a model can act on rather than in tracebacks.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one).
"""

import pytest

from kurisuassistant.tools import tool_registry
from kurisuassistant.tools.drive import (
    DriveDeleteTool,
    DriveListTool,
    DriveReadTool,
    DriveWriteTool,
)

pytestmark = pytest.mark.db

OWNER_ID = 1
OTHER_ID = 2


@pytest.fixture(autouse=True)
def drive_root(tmp_path, monkeypatch):
    from kurisuassistant.utils import drive_storage

    monkeypatch.setattr(drive_storage, "DRIVE_DIR", tmp_path / "drive")
    return tmp_path / "drive"


@pytest.fixture()
def accounts(system_db):
    """Two activated accounts, so "not yours" can be tested at all."""
    from kurisuassistant.core.accounts import provision_user
    from kurisuassistant.core.security import hash_password
    from kurisuassistant.db.repositories import UserRepository
    from kurisuassistant.db.session import get_session
    import uuid

    ids = []
    for _ in range(2):
        username = f"drive-tool-{uuid.uuid4().hex[:8]}"
        with get_session() as session:
            repo = UserRepository(session)
            user = repo.create_user(username, hash_password("x"))
            provision_user(session, user)
            user.is_active = True
            session.flush()
            ids.append(user.id)
    return ids


@pytest.fixture()
def db_running(system_client):
    """The tools go through the db service.

    Taken from ``system_client`` rather than started here: that fixture is
    session-scoped and runs the app's lifespan, so starting and stopping the
    service around each test would leave every later module in the session
    holding a dead singleton.
    """
    return system_client


async def _write(user_id, path, content, **extra):
    return await DriveWriteTool().execute(
        {"user_id": user_id, "path": path, "content": content, **extra}
    )


class TestRegistration:
    def test_all_four_are_registered(self):
        for name in ("drive_list", "drive_read", "drive_write", "drive_delete"):
            assert tool_registry.get(name) is not None, name

    def test_they_are_not_built_in(self):
        """`built_in` bypasses an account's `available_tools` allowlist. File
        access must not arrive that way — narrowing the allowlist has to be able
        to take the drive away."""
        for name in ("drive_list", "drive_read", "drive_write", "drive_delete"):
            assert tool_registry.get(name).built_in is False, name

    def test_user_id_is_not_something_the_model_can_set(self):
        """It is injected after the model has produced its arguments. If it were
        in the schema, a model could name someone else's account."""
        for tool in (DriveListTool(), DriveReadTool(), DriveWriteTool(), DriveDeleteTool()):
            properties = tool.get_schema()["function"]["parameters"]["properties"]
            assert "user_id" not in properties, tool.name


class TestNoUserContext:
    """With no account to scope to, a tool refuses rather than guessing."""

    @pytest.mark.parametrize(
        "tool,args",
        [
            (DriveListTool(), {"path": "/"}),
            (DriveReadTool(), {"path": "/x"}),
            (DriveWriteTool(), {"path": "/x", "content": "y"}),
            (DriveDeleteTool(), {"path": "/x"}),
        ],
    )
    async def test_it_says_so(self, tool, args):
        assert "No user context" in await tool.execute(args)


class TestWriteAndRead:
    async def test_a_write_is_readable_back(self, db_running, accounts):
        owner, _ = accounts
        assert "Written to /notes.md" in await _write(owner, "/notes.md", "# hello")

        read = await DriveReadTool().execute({"user_id": owner, "path": "/notes.md"})
        assert "# hello" in read

    async def test_a_missing_folder_says_which_one(self, db_running, accounts):
        owner, _ = accounts
        result = await _write(owner, "/Nowhere/notes.md", "x")
        assert "/Nowhere" in result and "Create it first" in result

    async def test_an_existing_file_is_not_overwritten_by_default(
        self, db_running, accounts
    ):
        owner, _ = accounts
        await _write(owner, "/twice.md", "first")
        result = await _write(owner, "/twice.md", "second")

        assert "already exists" in result
        read = await DriveReadTool().execute({"user_id": owner, "path": "/twice.md"})
        assert "first" in read

    async def test_overwrite_replaces_it(self, db_running, accounts):
        owner, _ = accounts
        await _write(owner, "/replaced.md", "first")
        await _write(owner, "/replaced.md", "second", if_exists="overwrite")

        read = await DriveReadTool().execute({"user_id": owner, "path": "/replaced.md"})
        assert "second" in read and "first" not in read

    async def test_a_name_that_would_look_like_a_path_is_refused(
        self, db_running, accounts
    ):
        owner, _ = accounts
        assert "not a name" in await _write(owner, "/..", "x")

    async def test_reading_something_that_is_not_there(self, db_running, accounts):
        owner, _ = accounts
        result = await DriveReadTool().execute({"user_id": owner, "path": "/ghost.md"})
        assert "nothing at /ghost.md" in result

    async def test_reading_a_folder_points_at_drive_list(self, db_running, accounts):
        owner, _ = accounts
        await _write(owner, "/afolder-holder.md", "x")
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service

        await get_db_service().execute(
            lambda s: DriveNodeRepository(s).create_folder(owner, None, "AFolder")
        )
        result = await DriveReadTool().execute({"user_id": owner, "path": "/AFolder"})
        assert "drive_list" in result

    async def test_a_read_is_bounded(self, db_running, accounts):
        """A 2 GB file handed to a model is context nobody asked to spend."""
        owner, _ = accounts
        await _write(owner, "/long.md", "x" * 5000)
        result = await DriveReadTool().execute(
            {"user_id": owner, "path": "/long.md", "max_bytes": 100}
        )
        assert "first 100 bytes only" in result
        assert result.count("x") == 100

    async def test_binary_is_refused_rather_than_returned_as_noise(
        self, db_running, accounts, drive_root
    ):
        owner, _ = accounts
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.utils import drive_storage

        async def _bytes():
            yield b"\x00\x01\x02\x03 not text"

        key, size, checksum = await drive_storage.store_stream(
            owner, _bytes(), quota_remaining=10_000
        )
        await get_db_service().execute(
            lambda s: DriveNodeRepository(s).create_file(
                owner, None, "blob.bin", size, "application/octet-stream", checksum, key
            )
        )

        result = await DriveReadTool().execute({"user_id": owner, "path": "/blob.bin"})
        assert "not a text file" in result


class TestList:
    async def test_it_names_what_is_there(self, db_running, accounts):
        owner, _ = accounts
        await _write(owner, "/listed-a.md", "a")
        await _write(owner, "/listed-b.md", "b")

        result = await DriveListTool().execute({"user_id": owner, "path": "/"})
        assert "listed-a.md" in result and "listed-b.md" in result

    async def test_an_empty_drive_says_so_rather_than_returning_nothing(
        self, db_running, accounts
    ):
        _, other = accounts
        assert "empty" in await DriveListTool().execute({"user_id": other, "path": "/"})

    async def test_a_missing_folder_says_so(self, db_running, accounts):
        owner, _ = accounts
        result = await DriveListTool().execute({"user_id": owner, "path": "/Nope"})
        assert "no folder at /Nope" in result

    async def test_listing_a_file_points_at_drive_read(self, db_running, accounts):
        owner, _ = accounts
        await _write(owner, "/afile.md", "x")
        result = await DriveListTool().execute({"user_id": owner, "path": "/afile.md"})
        assert "drive_read" in result


class TestDelete:
    async def test_a_file_goes_and_takes_its_bytes(
        self, db_running, accounts, drive_root
    ):
        owner, _ = accounts
        await _write(owner, "/doomed.md", "bye")
        assert [p for p in drive_root.rglob("*") if p.is_file()]

        result = await DriveDeleteTool().execute(
            {"user_id": owner, "path": "/doomed.md"}
        )
        assert "Deleted /doomed.md" in result
        assert "nothing at /doomed.md" in await DriveReadTool().execute(
            {"user_id": owner, "path": "/doomed.md"}
        )
        assert not [p for p in drive_root.rglob("*") if p.is_file()]

    async def test_a_full_folder_needs_recursive(self, db_running, accounts):
        """"Delete the notes folder" must not quietly take a subtree nobody
        mentioned."""
        owner, _ = accounts
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service

        folder = await get_db_service().execute(
            lambda s: DriveNodeRepository(s).create_folder(owner, None, "Keep").id
        )
        await _write(owner, "/Keep/inside.md", "still here")

        result = await DriveDeleteTool().execute({"user_id": owner, "path": "/Keep"})
        assert "recursive=true" in result
        assert "still here" in await DriveReadTool().execute(
            {"user_id": owner, "path": "/Keep/inside.md"}
        )
        assert folder  # the folder is still there

    async def test_recursive_takes_the_subtree(self, db_running, accounts, drive_root):
        owner, _ = accounts
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service

        await get_db_service().execute(
            lambda s: DriveNodeRepository(s).create_folder(owner, None, "Sweep")
        )
        await _write(owner, "/Sweep/inside.md", "goes too")

        result = await DriveDeleteTool().execute(
            {"user_id": owner, "path": "/Sweep", "recursive": True}
        )
        assert "everything in it" in result
        assert "no folder at /Sweep" in await DriveListTool().execute(
            {"user_id": owner, "path": "/Sweep"}
        )
        assert not [p for p in drive_root.rglob("*") if p.is_file()]

    async def test_the_root_cannot_be_deleted(self, db_running, accounts):
        owner, _ = accounts
        assert "cannot be deleted" in await DriveDeleteTool().execute(
            {"user_id": owner, "path": "/"}
        )

    async def test_deleting_something_that_is_not_there(self, db_running, accounts):
        owner, _ = accounts
        result = await DriveDeleteTool().execute({"user_id": owner, "path": "/ghost"})
        assert "nothing at /ghost" in result


class TestAccountScope:
    """The account comes from the injected user_id, so one account's tools can
    never reach another's files."""

    async def test_a_file_is_invisible_to_the_other_account(
        self, db_running, accounts
    ):
        owner, other = accounts
        await _write(owner, "/private.md", "mine")

        assert "nothing at /private.md" in await DriveReadTool().execute(
            {"user_id": other, "path": "/private.md"}
        )
        assert "private.md" not in await DriveListTool().execute(
            {"user_id": other, "path": "/"}
        )
        assert "nothing at /private.md" in await DriveDeleteTool().execute(
            {"user_id": other, "path": "/private.md"}
        )
        # ...and the owner still has it.
        assert "mine" in await DriveReadTool().execute(
            {"user_id": owner, "path": "/private.md"}
        )

    async def test_the_same_name_in_two_accounts_is_two_files(
        self, db_running, accounts
    ):
        owner, other = accounts
        await _write(owner, "/shared-name.md", "owner's copy")
        await _write(other, "/shared-name.md", "other's copy")

        assert "owner's copy" in await DriveReadTool().execute(
            {"user_id": owner, "path": "/shared-name.md"}
        )
        assert "other's copy" in await DriveReadTool().execute(
            {"user_id": other, "path": "/shared-name.md"}
        )


class TestApprovalSentences:
    """`describe_call` is what a user reads in the approval bar before pressing
    Enter. For an irreversible call it has to name the thing."""

    def test_a_write_names_the_file_and_the_size(self):
        sentence = DriveWriteTool().describe_call(
            {"path": "/Reports/q3-summary.md", "content": "x" * 1216}
        )
        assert "/Reports/q3-summary.md" in sentence
        assert "1.2 KB" in sentence
        assert "Nothing existing is overwritten" in sentence

    def test_an_overwriting_write_says_so(self):
        sentence = DriveWriteTool().describe_call(
            {"path": "/a.md", "content": "x", "if_exists": "overwrite"}
        )
        assert "replacing it" in sentence

    def test_a_delete_says_it_cannot_be_undone(self):
        sentence = DriveDeleteTool().describe_call({"path": "/Reports/old.md"})
        assert "/Reports/old.md" in sentence
        assert "cannot be undone" in sentence

    def test_a_recursive_delete_says_what_else_goes(self):
        sentence = DriveDeleteTool().describe_call(
            {"path": "/Reports", "recursive": True}
        )
        assert "everything inside it" in sentence

    def test_a_read_does_not_pretend_to_be_dangerous(self):
        assert "Read /a.md" in DriveReadTool().describe_call({"path": "/a.md"})


class TestModelSuppliedArguments:
    """Every value here comes from a language model, so a field the schema calls
    a string can arrive as anything at all.

    `describe_call` is the sharp edge: `BaseAgent.execute_tool` does not wrap it,
    so an exception raised while building the approval sentence fails the whole
    chat turn — for a call the user may already have set to allow.
    """

    @pytest.mark.parametrize("path", [None, 42, ["/a"], {"p": "/a"}, "", "   "])
    def test_describe_call_survives_any_path(self, path):
        for tool in (DriveListTool(), DriveReadTool(), DriveDeleteTool()):
            assert isinstance(tool.describe_call({"path": path}), str), tool.name
        assert isinstance(
            DriveWriteTool().describe_call({"path": path, "content": "x"}), str
        )

    @pytest.mark.parametrize("content", [None, 42, ["a"], {"c": "a"}])
    def test_describe_call_survives_any_content(self, content):
        sentence = DriveWriteTool().describe_call({"path": "/a.md", "content": content})
        assert isinstance(sentence, str)
        assert "/a.md" in sentence

    @pytest.mark.parametrize(
        "value,expected",
        [
            (True, True), (False, False), (None, False),
            ("true", True), ("True", True), ("yes", True), ("1", True),
            # The one that matters: `bool("false")` is True, and this flag guards
            # an irreversible recursive delete.
            ("false", False), ("False", False), ("no", False), ("0", False), ("", False),
        ],
    )
    def test_recursive_is_parsed_not_coerced(self, value, expected):
        sentence = DriveDeleteTool().describe_call({"path": "/Reports", "recursive": value})
        assert ("everything inside it" in sentence) is expected, value

    async def test_a_string_false_does_not_delete_a_folder(self, db_running, accounts):
        owner, _ = accounts
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service

        await get_db_service().execute(
            lambda s: DriveNodeRepository(s).create_folder(owner, None, "Survives")
        )
        await _write(owner, "/Survives/inside.md", "still here")

        result = await DriveDeleteTool().execute(
            {"user_id": owner, "path": "/Survives", "recursive": "false"}
        )

        assert "recursive=true" in result
        assert "still here" in await DriveReadTool().execute(
            {"user_id": owner, "path": "/Survives/inside.md"}
        )

    async def test_a_non_string_path_is_refused_rather_than_crashing(
        self, db_running, accounts
    ):
        owner, _ = accounts
        for tool in (DriveListTool(), DriveReadTool(), DriveDeleteTool()):
            result = await tool.execute({"user_id": owner, "path": 42})
            assert isinstance(result, str), tool.name


class TestListIsBounded:
    async def test_a_huge_folder_does_not_become_the_whole_context(
        self, db_running, accounts
    ):
        """`drive_read` is bounded and the history tools paginate; a folder with
        thousands of files must not be the one call that fills the window."""
        from kurisuassistant.tools.drive import MAX_LIST_ENTRIES

        owner, _ = accounts
        for i in range(MAX_LIST_ENTRIES + 15):
            await _write(owner, f"/many-{i:04d}.md", "x")

        result = await DriveListTool().execute({"user_id": owner, "path": "/"})

        assert result.count("\n- ") == MAX_LIST_ENTRIES
        assert "15 more, not listed" in result


class TestDriveSchemeReferences:
    """A chat message's `context_files` carry the client's own path spelling to
    the model verbatim, so the most natural thing for a model to do is hand it
    back. That has to work rather than be a mistake."""

    @pytest.mark.parametrize(
        "given,shown",
        [
            ("drive://Reports/Q3.md", "/Reports/Q3.md"),
            ("drive://Q3.md", "/Q3.md"),
            ("drive://", "/"),
            ("/Reports/Q3.md", "/Reports/Q3.md"),
            ("Reports/Q3.md", "/Reports/Q3.md"),
        ],
    )
    def test_the_approval_sentence_shows_a_plain_path(self, given, shown):
        assert DriveReadTool().describe_call({"path": given}) == f"Read {shown} from the drive"

    async def test_a_scheme_reference_reads_the_same_file(self, db_running, accounts):
        owner, _ = accounts
        await _write(owner, "/scheme-check.md", "found it")

        assert "found it" in await DriveReadTool().execute(
            {"user_id": owner, "path": "drive://scheme-check.md"}
        )
