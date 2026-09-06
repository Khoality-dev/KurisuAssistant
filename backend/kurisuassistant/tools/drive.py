"""Kurisu Drive tools — the assistant's view of the user's stored files.

These go through :class:`DriveNodeRepository` and ``utils/drive_storage`` — the
same layer ``routers/drive.py`` uses — so the assistant cannot reach anything the
HTTP API would refuse, and there is one implementation of what the drive allows
rather than two that drift.

Scope comes from ``args["user_id"]``, injected by ``BaseAgent.execute_tool``
after the model has produced its arguments; it is not in the declared schema and
the model cannot set it. A tool with no user context refuses rather than
guessing, exactly as the history tools do.

Approval is not this module's job. ``users.tool_policies`` is applied in
``agents/base.py`` before any of this runs: a stored ``deny`` never reaches here,
a stored ``allow`` skips the prompt, and anything else stops at the client's
approval bar. What these tools owe that bar is a ``describe_call`` sentence
worth reading before someone presses Enter — which is why the write and delete
ones name the file and the size rather than dumping the arguments.
"""

import logging
from typing import Any, Dict

from .base import BaseTool

logger = logging.getLogger(__name__)

#: A file handed to a model costs real context, so a read is bounded. The
#: default is generous for notes and source and far under anything that would
#: crowd out the conversation.
DEFAULT_READ_BYTES = 64 * 1024
MAX_READ_BYTES = 256 * 1024

#: A folder listing costs context too. `drive_read` is bounded and the history
#: tools paginate; a folder with ten thousand files must not be the one call
#: that fills the window.
MAX_LIST_ENTRIES = 200

NO_USER = "Error: No user context available."

#: How the desktop client spells a drive path in a chat reference. The tools
#: accept it because that is the string the model is shown.
DRIVE_SCHEME = "drive://"


def _format_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{size / (1024 * 1024 * 1024):.1f} GB"


def _normalise(path: Any) -> str:
    """A path, whatever the model actually sent.

    Every value here comes from a language model, which means a field the schema
    calls a string can arrive as a number, a list or nothing. `describe_call` is
    not wrapped by ``BaseAgent.execute_tool``, so an AttributeError raised while
    building the approval sentence does not fail the *tool* — it fails the whole
    chat turn, for a call the user may already have set to allow.
    """
    if path is None:
        return "/"
    if not isinstance(path, str):
        path = str(path)
    path = path.strip()
    if not path:
        return "/"
    # The desktop client writes drive references as `drive://Reports/Q3.md`, and
    # a chat message's context_files carry that string to the model verbatim —
    # so the most natural thing for a model to do is hand it straight back. Take
    # it rather than making it a mistake.
    if path.startswith(DRIVE_SCHEME):
        path = "/" + path[len(DRIVE_SCHEME):]
    return path if path.startswith("/") else "/" + path


def _as_text(value: Any) -> str:
    """Content, whatever the model actually sent."""
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def _as_bool(value: Any) -> bool:
    """A flag, whatever the model actually sent.

    ``bool("false")`` is True, and this flag guards an irreversible recursive
    delete: a model that spells the refusal it was asked for must not get the
    deletion instead.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y", "on"}
    if value is None:
        return False
    return bool(value)


def _split_parent(path: str):
    """``/Reports/q3.md`` → ``('/Reports', 'q3.md')``."""
    from kurisuassistant.db.repositories import split_path

    segments = split_path(path)
    if not segments:
        return "/", ""
    return "/" + "/".join(segments[:-1]), segments[-1]


class DriveListTool(BaseTool):
    """List a folder in the user's drive."""

    name = "drive_list"
    description = (
        "List the contents of a folder in the user's Kurisu Drive — the account's "
        "own file storage on this server, shared by every device they sign in from. "
        "Returns each entry's name, whether it is a folder, its size and when it "
        "last changed. Use '/' for the top level."
    )

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Folder to list, e.g. '/' or '/Reports'. Defaults to '/'.",
                        },
                    },
                    "required": [],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"List the drive folder {_normalise(args.get('path'))}"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service

        user_id = args.get("user_id")
        if not user_id:
            return NO_USER

        path = _normalise(args.get("path"))

        def _list(session):
            repo = DriveNodeRepository(session)
            parent_id = None
            if path != "/":
                node = repo.resolve_path(user_id, path)
                if node is None:
                    return None
                if not node.is_dir:
                    return "not-a-folder"
                parent_id = node.id
            return [
                (n.name, n.is_dir, n.size, n.updated_at)
                for n in repo.list_children(user_id, parent_id)
            ]

        rows = await get_db_service().execute(_list)
        if rows is None:
            return f"There is no folder at {path} in the drive."
        if rows == "not-a-folder":
            return f"{path} is a file, not a folder. Use drive_read to read it."
        if not rows:
            return f"{path} is empty."

        shown = rows[:MAX_LIST_ENTRIES]
        lines = [f"{path} — {len(rows)} item{'s' if len(rows) != 1 else ''}:"]
        for name, is_dir, size, updated in shown:
            when = updated.isoformat() + "Z" if updated else "unknown"
            if is_dir:
                lines.append(f"- {name}/ (folder, changed {when})")
            else:
                lines.append(f"- {name} ({_format_size(size)}, changed {when})")
        if len(rows) > len(shown):
            lines.append(
                f"…and {len(rows) - len(shown)} more, not listed. Open a subfolder to narrow it down."
            )
        return "\n".join(lines)


class DriveReadTool(BaseTool):
    """Read a text file from the user's drive."""

    name = "drive_read"
    description = (
        "Read a text file from the user's Kurisu Drive and return its contents. "
        "Only text is returned; a binary file (an image, a PDF, an archive) is "
        "refused rather than returned as noise. Long files are truncated."
    )

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File to read, e.g. '/Reports/Q3-revenue-notes.md'.",
                        },
                        "max_bytes": {
                            "type": "integer",
                            "description": (
                                f"How much to read at most (default {DEFAULT_READ_BYTES}, "
                                f"capped at {MAX_READ_BYTES})."
                            ),
                        },
                    },
                    "required": ["path"],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Read {_normalise(args.get('path'))} from the drive"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.utils import drive_storage

        user_id = args.get("user_id")
        if not user_id:
            return NO_USER

        path = _normalise(args.get("path"))
        if path == "/":
            return "That is the top of the drive, not a file."

        try:
            max_bytes = int(args.get("max_bytes") or DEFAULT_READ_BYTES)
        except (TypeError, ValueError):
            max_bytes = DEFAULT_READ_BYTES
        max_bytes = max(1, min(max_bytes, MAX_READ_BYTES))

        def _find(session):
            node = DriveNodeRepository(session).resolve_path(user_id, path)
            if node is None:
                return None
            return {"is_dir": node.is_dir, "size": node.size, "storage_key": node.storage_key}

        meta = await get_db_service().execute(_find)
        if meta is None:
            return f"There is nothing at {path} in the drive."
        if meta["is_dir"]:
            return f"{path} is a folder. Use drive_list to see what is in it."

        try:
            text, truncated = await drive_storage.read_text(
                user_id, meta["storage_key"], max_bytes
            )
        except ValueError:
            return (
                f"{path} is not a text file ({_format_size(meta['size'])}). "
                "It can be downloaded from the drive, but not read as text."
            )
        except OSError:
            logger.error("drive_read: blob missing for user %s at %s", user_id, path, exc_info=True)
            return f"{path} could not be read."

        header = f"{path} ({_format_size(meta['size'])})"
        if truncated:
            header += f" — first {max_bytes} bytes only"
        return f"{header}:\n\n{text}"


class DriveWriteTool(BaseTool):
    """Write a text file to the user's drive."""

    name = "drive_write"
    description = (
        "Write a text file to the user's Kurisu Drive. The folder it goes in must "
        "already exist. By default an existing file of the same name is not "
        "touched; pass if_exists='overwrite' to replace it."
    )

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Where to write, e.g. '/Reports/q3-summary.md'.",
                        },
                        "content": {
                            "type": "string",
                            "description": "The full text of the file.",
                        },
                        "if_exists": {
                            "type": "string",
                            "enum": ["fail", "overwrite"],
                            "description": "What to do when the file already exists. Default 'fail'.",
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        path = _normalise(args.get("path"))
        size = len(_as_text(args.get("content")).encode("utf-8"))
        if _as_text(args.get("if_exists")) == "overwrite":
            return f"Write {_format_size(size)} to {path} on the drive, replacing it if it exists"
        return f"Create {path} on the drive ({_format_size(size)}). Nothing existing is overwritten"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.utils import drive_storage

        user_id = args.get("user_id")
        if not user_id:
            return NO_USER

        path = _normalise(args.get("path"))
        if args.get("content") is None:
            return "Nothing to write: content is required."
        content = _as_text(args.get("content"))
        overwrite = _as_text(args.get("if_exists")) == "overwrite"

        parent_path, name = _split_parent(path)
        if not name:
            return "That is the top of the drive, not a file name."
        try:
            drive_storage.validate_name(name)
        except Exception:
            return f"'{name}' is not a name a file can have on the drive."

        data = content.encode("utf-8")

        def _plan(session):
            repo = DriveNodeRepository(session)
            parent_id = None
            if parent_path != "/":
                parent = repo.resolve_path(user_id, parent_path)
                if parent is None:
                    return {"error": f"There is no folder at {parent_path}. Create it first."}
                if not parent.is_dir:
                    return {"error": f"{parent_path} is a file, not a folder."}
                parent_id = parent.id
            existing = repo.get_child(user_id, parent_id, name)
            if existing and existing.is_dir:
                return {"error": f"{path} is a folder."}
            if existing and not overwrite:
                return {
                    "error": (
                        f"{path} already exists. Pass if_exists='overwrite' to replace it."
                    )
                }
            used, _ = repo.usage(user_id)
            reclaimed = existing.size if existing else 0
            return {
                "parent_id": parent_id,
                "existing_id": existing.id if existing else None,
                "quota_remaining": drive_storage.QUOTA_BYTES - used + reclaimed,
            }

        plan = await get_db_service().execute(_plan)
        if "error" in plan:
            return plan["error"]
        if len(data) > plan["quota_remaining"]:
            return "The drive is full. Remove something first."

        async def _chunks():
            for start in range(0, len(data), drive_storage.CHUNK_SIZE):
                yield data[start:start + drive_storage.CHUNK_SIZE]

        storage_key, size, checksum = await drive_storage.store_stream(
            user_id, _chunks(), plan["quota_remaining"]
        )
        mime = drive_storage.guess_mime(name)

        def _persist(session):
            repo = DriveNodeRepository(session)
            if plan["existing_id"] is not None:
                node = repo.get_by_user_and_id(user_id, plan["existing_id"])
                if node is not None:
                    replaced = repo.replace_file(node, size, mime, checksum, storage_key)
                    repo.touch_parents(node)
                    return replaced
            node = repo.create_file(
                user_id, plan["parent_id"], name, size, mime, checksum, storage_key
            )
            repo.touch_parents(node)
            return None

        try:
            replaced_key = await get_db_service().execute(_persist)
        except BaseException:
            await drive_storage.delete_blobs(user_id, [storage_key])
            raise

        if replaced_key:
            await drive_storage.delete_blobs(user_id, [replaced_key])
        return f"Written to {path} ({_format_size(size)})."


class DriveDeleteTool(BaseTool):
    """Delete a file or folder from the user's drive."""

    name = "drive_delete"
    description = (
        "Delete a file from the user's Kurisu Drive. This is permanent — there is "
        "no trash and no undo. A folder is only deleted when recursive is true, "
        "and then everything inside it goes too."
    )

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "What to delete, e.g. '/Reports/old-draft.md'.",
                        },
                        "recursive": {
                            "type": "boolean",
                            "description": (
                                "Required to delete a folder. Everything inside it is "
                                "deleted as well. Default false."
                            ),
                        },
                    },
                    "required": ["path"],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        path = _normalise(args.get("path"))
        if _as_bool(args.get("recursive")):
            return f"Permanently delete {path} from the drive, and everything inside it"
        return f"Permanently delete {path} from the drive. This cannot be undone"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.repositories import DriveNodeRepository
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.utils import drive_storage

        user_id = args.get("user_id")
        if not user_id:
            return NO_USER

        path = _normalise(args.get("path"))
        if path == "/":
            return "The top of the drive cannot be deleted."
        recursive = _as_bool(args.get("recursive"))

        def _delete(session):
            repo = DriveNodeRepository(session)
            node = repo.resolve_path(user_id, path)
            if node is None:
                return {"error": f"There is nothing at {path} in the drive."}
            if node.is_dir and not recursive:
                children = repo.list_children(user_id, node.id)
                if children:
                    return {
                        "error": (
                            f"{path} is a folder holding {len(children)} item"
                            f"{'s' if len(children) != 1 else ''}. "
                            "Pass recursive=true to delete it and everything in it."
                        )
                    }
            size = node.size
            keys = repo.delete_subtree(user_id, node)
            return {"keys": keys, "size": size, "was_dir": node.is_dir}

        result = await get_db_service().execute(_delete)
        if "error" in result:
            return result["error"]

        await drive_storage.delete_blobs(user_id, result["keys"])
        if result["was_dir"]:
            return f"Deleted the folder {path} and everything in it."
        return f"Deleted {path} ({_format_size(result['size'])})."
