"""Notes tools — file-based persistent notes for agents.

Six built-in tools for managing a per-agent notes filesystem:
notes_list, notes_read, notes_write, notes_edit, notes_delete, notes_search
"""

import json
import logging
import os
from pathlib import Path
from typing import Dict, Any

from .base import BaseTool

logger = logging.getLogger(__name__)

NOTES_ROOT = os.getenv("NOTES_ROOT", os.path.join("data", "notes"))

# Track read files per-agent for edit-requires-read enforcement
# Key: (user_id, agent_id, path) — reset each conversation is not needed,
# we just need to ensure the file was read at some point.
_read_files: set[str] = set()


def _resolve_path(user_id: int, agent_id: int, path: str) -> Path:
    """Resolve relative path within agent's notes directory. Raises ValueError on traversal."""
    root = Path(NOTES_ROOT) / str(user_id) / str(agent_id)
    resolved = (root / path).resolve()
    if not str(resolved).startswith(str(root.resolve())):
        raise ValueError(f"Path traversal not allowed: {path}")
    return resolved


def _get_root(user_id: int, agent_id: int) -> Path:
    """Get agent's notes root, creating if needed."""
    root = Path(NOTES_ROOT) / str(user_id) / str(agent_id)
    root.mkdir(parents=True, exist_ok=True)
    return root


class NotesListTool(BaseTool):
    name = "notes_list"
    description = (
        "List files and folders in your notes directory. "
        "Use without a path to see the root contents, or specify a subfolder path."
    )
    requires_approval = False
    built_in = True

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
                            "description": "Relative path to list. Omit for root directory.",
                        },
                    },
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        user_id = args.get("user_id")
        agent_id = args.get("agent_id")
        if not user_id or not agent_id:
            return json.dumps({"error": "Missing context."})

        path = args.get("path", "")

        try:
            root = _get_root(user_id, agent_id)
            target = _resolve_path(user_id, agent_id, path) if path else root

            if not target.exists():
                return json.dumps({"error": f"Directory not found: {path or '/'}"})
            if not target.is_dir():
                return json.dumps({"error": f"Not a directory: {path}"})

            entries = []
            for item in sorted(target.iterdir()):
                if item.name.startswith("."):
                    continue
                rel = str(item.relative_to(root))
                entry = {
                    "path": rel + "/" if item.is_dir() else rel,
                    "type": "directory" if item.is_dir() else "file",
                }
                if item.is_file():
                    entry["size"] = item.stat().st_size
                entries.append(entry)

            return json.dumps(entries)

        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            logger.error("notes_list failed: %s", e, exc_info=True)
            return json.dumps({"error": str(e)})

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"List notes: {args.get('path', '/')}"


class NotesReadTool(BaseTool):
    name = "notes_read"
    description = (
        "Read a file from your notes with line pagination. "
        "Returns content with line numbers. Use offset/limit for large files."
    )
    requires_approval = False
    built_in = True

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
                            "description": "Relative path to the file.",
                        },
                        "offset": {
                            "type": "integer",
                            "description": "Starting line number, 0-based (default: 0).",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum lines to return (default: 200).",
                        },
                    },
                    "required": ["path"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        user_id = args.get("user_id")
        agent_id = args.get("agent_id")
        if not user_id or not agent_id:
            return json.dumps({"error": "Missing context."})

        path = args.get("path", "")
        offset = args.get("offset", 0)
        limit = args.get("limit", 200)

        try:
            resolved = _resolve_path(user_id, agent_id, path)

            if not resolved.exists():
                return json.dumps({"error": f"File not found: {path}"})
            if resolved.is_dir():
                return json.dumps({"error": f"Cannot read a directory. Use notes_list instead."})

            content = resolved.read_text(encoding="utf-8")
            lines = content.splitlines()
            total_lines = len(lines)

            selected = lines[offset:offset + limit]
            result_text = "\n".join(selected)

            _read_files.add(str(resolved))

            output = {"content": result_text, "total_lines": total_lines}
            if offset + limit < total_lines:
                output["truncated"] = True
                output["next_offset"] = offset + limit

            return json.dumps(output)

        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            logger.error("notes_read failed: %s", e, exc_info=True)
            return json.dumps({"error": str(e)})

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Read note: {args.get('path')}"


class NotesWriteTool(BaseTool):
    name = "notes_write"
    description = (
        "Create or overwrite a file in your notes. "
        "Automatically creates parent directories if needed."
    )
    requires_approval = False
    built_in = True

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
                            "description": "Relative path for the file.",
                        },
                        "content": {
                            "type": "string",
                            "description": "Full file content to write.",
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        user_id = args.get("user_id")
        agent_id = args.get("agent_id")
        if not user_id or not agent_id:
            return json.dumps({"error": "Missing context."})

        path = args.get("path", "")
        content = args.get("content", "")

        try:
            resolved = _resolve_path(user_id, agent_id, path)

            if resolved.is_dir():
                return json.dumps({"error": f"Cannot write to a directory: {path}"})

            resolved.parent.mkdir(parents=True, exist_ok=True)
            resolved.write_text(content, encoding="utf-8")
            _read_files.add(str(resolved))

            return json.dumps({"status": "ok", "path": path})

        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            logger.error("notes_write failed: %s", e, exc_info=True)
            return json.dumps({"error": str(e)})

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Write note: {args.get('path')}"


class NotesEditTool(BaseTool):
    name = "notes_edit"
    description = (
        "Edit a file by replacing text. Must read the file first with notes_read. "
        "The old_text must match exactly one location in the file."
    )
    requires_approval = False
    built_in = True

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
                            "description": "Relative path to the file.",
                        },
                        "old_text": {
                            "type": "string",
                            "description": "Exact text to find and replace.",
                        },
                        "new_text": {
                            "type": "string",
                            "description": "Replacement text.",
                        },
                    },
                    "required": ["path", "old_text", "new_text"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        user_id = args.get("user_id")
        agent_id = args.get("agent_id")
        if not user_id or not agent_id:
            return json.dumps({"error": "Missing context."})

        path = args.get("path", "")
        old_text = args.get("old_text", "")
        new_text = args.get("new_text", "")

        try:
            resolved = _resolve_path(user_id, agent_id, path)

            if not resolved.exists():
                return json.dumps({"error": f"File not found: {path}"})

            if str(resolved) not in _read_files:
                return json.dumps({"error": "Must read the file with notes_read before editing."})

            content = resolved.read_text(encoding="utf-8")

            if old_text not in content:
                return json.dumps({"error": "old_text not found in file."})

            count = content.count(old_text)
            if count > 1:
                return json.dumps({"error": f"old_text matches {count} locations. Provide more context to make it unique."})

            new_content = content.replace(old_text, new_text, 1)
            resolved.write_text(new_content, encoding="utf-8")

            return json.dumps({"status": "ok", "path": path})

        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            logger.error("notes_edit failed: %s", e, exc_info=True)
            return json.dumps({"error": str(e)})

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Edit note: {args.get('path')}"


class NotesDeleteTool(BaseTool):
    name = "notes_delete"
    description = "Delete a file or empty directory from your notes."
    requires_approval = False
    built_in = True

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
                            "description": "Relative path to delete.",
                        },
                    },
                    "required": ["path"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        user_id = args.get("user_id")
        agent_id = args.get("agent_id")
        if not user_id or not agent_id:
            return json.dumps({"error": "Missing context."})

        path = args.get("path", "")

        try:
            resolved = _resolve_path(user_id, agent_id, path)
            root = _get_root(user_id, agent_id).resolve()

            if not resolved.exists():
                return json.dumps({"error": f"Not found: {path}"})

            if resolved == root:
                return json.dumps({"error": "Cannot delete the root directory."})

            if resolved.is_dir():
                if any(resolved.iterdir()):
                    return json.dumps({"error": f"Directory not empty: {path}"})
                resolved.rmdir()
            else:
                resolved.unlink()
                _read_files.discard(str(resolved))

            return json.dumps({"status": "ok", "path": path, "deleted": True})

        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            logger.error("notes_delete failed: %s", e, exc_info=True)
            return json.dumps({"error": str(e)})

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Delete note: {args.get('path')}"


class NotesSearchTool(BaseTool):
    name = "notes_search"
    description = (
        "Search your notes by filename and file content. "
        "Finds matches in both file/folder names and inside file text (case-insensitive)."
    )
    requires_approval = False
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Text to search for (case-insensitive).",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        user_id = args.get("user_id")
        agent_id = args.get("agent_id")
        if not user_id or not agent_id:
            return json.dumps({"error": "Missing context."})

        query = args.get("query", "")
        if not query:
            return json.dumps({"error": "query is required."})

        try:
            root = _get_root(user_id, agent_id)
            results = []
            query_lower = query.lower()
            max_results = 50

            for file_path in sorted(root.rglob("*")):
                if len(results) >= max_results:
                    break
                if file_path.name.startswith("."):
                    continue

                rel = str(file_path.relative_to(root))

                # Search filename
                if query_lower in rel.lower():
                    results.append({
                        "path": rel + "/" if file_path.is_dir() else rel,
                        "match": "filename",
                    })

                # Search file contents
                if file_path.is_file():
                    try:
                        content = file_path.read_text(encoding="utf-8")
                        for i, line in enumerate(content.splitlines()):
                            if query_lower in line.lower():
                                results.append({
                                    "path": rel,
                                    "match": "content",
                                    "line": i + 1,
                                    "snippet": line.strip()[:200],
                                })
                                if len(results) >= max_results:
                                    break
                    except (UnicodeDecodeError, PermissionError):
                        continue

            return json.dumps(results)

        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            logger.error("notes_search failed: %s", e, exc_info=True)
            return json.dumps({"error": str(e)})

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Search notes: {args.get('query')}"
