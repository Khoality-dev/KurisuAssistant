"""Export/import payloads shared by the persona and sub-agent routers.

One agent row used to be exported by one endpoint. The split gives personas and
sub-agents their own routes, but the file format stays one format with a ``kind``
discriminator, so a user cannot tell from a filename which endpoint to post it to
and the server can say so honestly.

Three defects from the v2 exporter are deliberately not carried forward:

* ``trigger_word`` and ``use_deferred_tools`` were never written, so an import
  could never restore them. ``trigger_word`` is now the assistant's, not a
  persona's, and has no export at all; ``use_deferred_tools`` belongs to a
  sub-agent and is exported with it.
* ``character_config`` was copied verbatim while no asset file was copied with
  it. Every URL inside it points at ``/character-assets/{exporter persona id}/``,
  so an imported persona rendered another install's art or 404s — and the next
  config save ran the asset cleanup, which deletes every file the config does not
  reference, taking the *original* persona's art with it. Media does not travel:
  ``character_config``, ``avatar_uuid`` and ``voice_reference`` are all handles to
  files that exist only on the machine that exported them, so none of the three is
  exported and all three are dropped from a v2 file on the way in.
"""

from typing import Any, List, Optional

from kurisuassistant.core.accounts import RESERVED_AGENT_NAMES

#: Current export format. v3 splits the old agent into two kinds.
EXPORT_VERSION = 3

#: The one older format still accepted. v2 files carry ``agent_type``.
LEGACY_EXPORT_VERSION = 2

KIND_PERSONA = "persona"
KIND_SUB_AGENT = "sub_agent"
KINDS = (KIND_PERSONA, KIND_SUB_AGENT)

__all__ = [
    "EXPORT_VERSION", "LEGACY_EXPORT_VERSION", "KIND_PERSONA", "KIND_SUB_AGENT",
    "KINDS", "RESERVED_AGENT_NAMES", "kind_of", "parse_export", "imported_name",
    "deduplicate_name", "export_filename",
]

_KIND_LABEL = {KIND_PERSONA: "persona", KIND_SUB_AGENT: "sub-agent"}


def _as_text(value: Any, default: str = "") -> str:
    """Coerce an imported JSON value to text; anything odd becomes the default."""
    if isinstance(value, str):
        return value
    return default


def _as_optional_text(value: Any) -> Optional[str]:
    if isinstance(value, str) and value:
        return value
    return None


def _as_tool_list(value: Any) -> Optional[List[str]]:
    """``None`` means every tool. Anything that is not a list of names means that too."""
    if isinstance(value, list):
        return [str(item) for item in value]
    return None


def kind_of(meta: dict) -> str:
    """Which kind of thing a parsed export file describes.

    Raises:
        ValueError: If the version is unsupported or the kind is unrecognised.
    """
    version = meta.get("version")
    if version == EXPORT_VERSION:
        kind = meta.get("kind")
        if kind not in KINDS:
            raise ValueError(
                f"Unrecognised export kind {kind!r}. Expected 'persona' or 'sub_agent'."
            )
        return kind

    if version == LEGACY_EXPORT_VERSION:
        # v2 held both halves on one row. A main agent becomes a persona and loses
        # its capability config to the user's single assistant; a sub-agent keeps it.
        agent_type = meta.get("agent_type") or "main"
        if agent_type == "main":
            return KIND_PERSONA
        if agent_type == "sub":
            return KIND_SUB_AGENT
        raise ValueError(
            f"Unrecognised agent_type {agent_type!r} in a version 2 export. "
            "Expected 'main' or 'sub'."
        )

    raise ValueError(
        f"Unsupported export version {version!r}. This server reads versions "
        f"{LEGACY_EXPORT_VERSION} and {EXPORT_VERSION}."
    )


def parse_export(meta: dict, expected_kind: str) -> dict:
    """Normalise an export file into keyword arguments for the matching repository.

    Accepts v3 (``kind``) and v2 (``agent_type``) files. A v2 main agent's model,
    tools, reasoning flags and memory are dropped: those belong to the importing
    user's own assistant now, and silently overwriting it from a file someone else
    wrote would change what the assistant can do behind their back.

    Args:
        meta: Parsed JSON from the uploaded file
        expected_kind: The kind this endpoint creates, KIND_PERSONA or KIND_SUB_AGENT

    Returns:
        Keyword arguments for ``create_persona`` / ``create_sub_agent``, minus ``name``

    Raises:
        ValueError: If the version, kind, or the endpoint/kind pairing is wrong
    """
    if not isinstance(meta, dict):
        raise ValueError("An export file must contain a JSON object.")

    kind = kind_of(meta)
    if kind != expected_kind:
        raise ValueError(
            f"This file describes a {_KIND_LABEL[kind]}, not a "
            f"{_KIND_LABEL[expected_kind]}. Import it from the "
            f"{'personas' if kind == KIND_PERSONA else 'sub-agents'} screen instead."
        )

    common = {
        "description": _as_text(meta.get("description")),
        "system_prompt": _as_text(meta.get("system_prompt")),
    }

    if kind == KIND_PERSONA:
        # No media: see the module docstring. No model/tools either — capability
        # is the assistant's.
        return {**common, "preferred_name": _as_optional_text(meta.get("preferred_name"))}

    return {
        **common,
        "model_name": _as_optional_text(meta.get("model_name")),
        "provider_type": _as_text(meta.get("provider_type"), "ollama") or "ollama",
        "available_tools": _as_tool_list(meta.get("available_tools")),
        "think": bool(meta.get("think", False)),
        "use_deferred_tools": bool(meta.get("use_deferred_tools", False)),
    }


def imported_name(meta: dict, fallback: str) -> str:
    """The name an export file asks for, before de-duplication."""
    name = meta.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    return fallback


def deduplicate_name(name: str, taken: List[str]) -> str:
    """Return a name free of collisions with ``taken`` and the reserved names."""
    original = name
    counter = 2
    while name in taken or name in RESERVED_AGENT_NAMES:
        name = f"{original} ({counter})"
        counter += 1
    return name


def export_filename(name: str) -> str:
    """A download filename that cannot escape its directory or break the header."""
    safe = "".join(c for c in name if c.isalnum() or c in " _-").strip()
    safe = safe.replace(" ", "_")
    return f"{safe or 'export'}.json"
