"""Base agent plumbing: shared dataclasses, tool execution, MCP fallback.

Concrete agents live in ``main.py`` (MainAgent) and ``sub.py`` (SubAgent).
BaseAgent itself has no ``process()`` / ``execute()`` — the two concrete
agents have different calling conventions (streaming to the user vs.
returning a single string), so the interface diverges.
"""

import asyncio
import json
import logging
from abc import ABC
from dataclasses import dataclass, field
from typing import Callable, Coroutine, Dict, List, Any, Optional, TYPE_CHECKING

from kurisuassistant.websocket.events import (
    ToolApprovalRequestEvent,
)
from kurisuassistant.tools import ToolRegistry

if TYPE_CHECKING:
    from kurisuassistant.websocket.handlers import ChatSessionHandler

logger = logging.getLogger(__name__)


_SENTINEL = object()


async def async_iterate(sync_iterator):
    """Convert a synchronous iterator to an async one using threads.

    This allows asyncio.CancelledError to be raised between iterations,
    making synchronous streams (like Ollama) cancellable.
    """
    it = iter(sync_iterator)
    while True:
        chunk = await asyncio.to_thread(next, it, _SENTINEL)
        if chunk is _SENTINEL:
            break
        yield chunk


@dataclass
class AssistantConfig:
    """What the assistant can do — one per user, independent of the voice.

    Model, tools, reasoning switches and the single memory document, plus the
    voice wake word. A persona swap changes who is speaking; none of this moves
    with it. Mirrors ``db.models.Assistant``.
    """
    id: Optional[int] = None
    model_name: Optional[str] = None
    provider_type: str = "ollama"
    available_tools: Optional[List[str]] = None  # None = every tool
    think: bool = False
    use_deferred_tools: bool = False
    memory: Optional[str] = None
    memory_enabled: bool = True
    # Voice wake word. Saying it wakes the assistant; it selects nothing.
    trigger_word: Optional[str] = None


@dataclass
class PersonaConfig:
    """How the assistant sounds — the identity half. Mirrors ``db.models.Persona``.

    Presentation only: no model, no tools, no memory, no trigger word. A
    conversation binds to exactly one of these.
    """
    id: Optional[int] = None
    name: str = ""
    description: str = ""
    system_prompt: str = ""
    preferred_name: Optional[str] = None  # what this persona calls the *user*
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[Dict] = None
    enabled: bool = True


@dataclass
class SubAgentConfig:
    """A task-only worker. Mirrors ``db.models.SubAgent``.

    Carries both halves at once because a sub-agent is its own capability and
    its own (internal) label: it runs its own LLM loop but never speaks to the
    user, is never bound to a conversation, and holds no memory.
    """
    id: Optional[int] = None
    name: str = ""
    description: str = ""
    system_prompt: str = ""
    model_name: Optional[str] = None
    provider_type: str = "ollama"
    available_tools: Optional[List[str]] = None  # None = every tool
    think: bool = False
    use_deferred_tools: bool = False


@dataclass
class AgentContext:
    """Context passed to agent during processing."""
    user_id: int = 0
    conversation_id: int = 0
    model_name: str = ""
    handler: Optional["ChatSessionHandler"] = None
    user_system_prompt: str = ""
    preferred_name: str = ""
    api_url: Optional[str] = None
    gemini_api_key: Optional[str] = None
    nvidia_api_key: Optional[str] = None
    poe_api_key: Optional[str] = None
    client_tools: List[Dict] = field(default_factory=list)
    client_tool_callback: Optional[Callable[[str, Dict], Coroutine[Any, Any, str]]] = None
    images: Optional[List[str]] = None
    context_size: Optional[int] = None
    compacted_context: str = ""
    # {tool_name: "allow" | "deny"} from users.tool_policies. The server decides
    # with this; the client's approval answer can only narrow it, never widen it.
    tool_policies: Dict[str, str] = field(default_factory=dict)


@dataclass
class ToolResult:
    """Result from a tool execution, optionally including images."""
    content: str
    images: List[str] = field(default_factory=list)
    status: str = "success"  # "success" | "error" | "denied"

    @staticmethod
    def _detect_error(content: str) -> bool:
        import json as _json
        stripped = content.strip()
        if stripped.startswith("{"):
            try:
                parsed = _json.loads(stripped)
                if isinstance(parsed, dict) and "error" in parsed:
                    return True
            except (_json.JSONDecodeError, ValueError):
                pass
        if stripped.startswith("Client tool error:") or stripped.startswith("MCP client not available"):
            return True
        return False

    @staticmethod
    def _detect_denied(content: str) -> bool:
        lc = content.lower()
        return "denied by user" in lc or "denied by the user" in lc

    @staticmethod
    def from_content(content: str, **kwargs) -> "ToolResult":
        if ToolResult._detect_denied(content):
            status = "denied"
        elif ToolResult._detect_error(content):
            status = "error"
        else:
            status = "success"
        return ToolResult(content=content, status=status, **kwargs)


class BaseAgent(ABC):
    """Abstract base: shared tool-approval plumbing for Main and Sub agents.

    Subclasses implement their own top-level entry point (``process`` for
    streaming main agents, ``execute`` for one-shot sub agents). The
    tool-approval flow and MCP fallback live here because they're identical
    for both.
    """

    def __init__(
        self,
        capabilities,
        tool_registry: ToolRegistry,
        *,
        identity=None,
    ):
        """Bind the two halves an agent runs on.

        ``capabilities`` answers "what can this run" — model, tools, reasoning
        (an :class:`AssistantConfig` for MainAgent, a :class:`SubAgentConfig`
        for SubAgent). ``identity`` answers "who is speaking" — name, prompt,
        voice (a :class:`PersonaConfig` for MainAgent). A SubAgent is both at
        once, so it passes one object and ``identity`` defaults to it.
        """
        self.capabilities = capabilities
        self.identity = identity if identity is not None else capabilities
        self.tool_registry = tool_registry

    async def execute_tool(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        context: AgentContext,
        _depth: int = 0,
    ) -> ToolResult:
        """Resolve and run a tool call, subject to the user's tool policy.

        The server decides first, from ``context.tool_policies``: a stored deny
        is final, a stored allow skips the prompt, and anything else is put to
        the connected client, whose answer can only narrow that decision.
        """
        import json as _json

        # Deferred tools: intercept call_tool and delegate to the inner tool.
        # One level of indirection is all the protocol needs; a model that names
        # call_tool as its own inner tool would otherwise recurse until the
        # interpreter gives up.
        if tool_name == "call_tool":
            if _depth >= 1:
                logger.warning("Refusing nested call_tool from agent '%s'", self.identity.name)
                return ToolResult(
                    content="call_tool cannot invoke call_tool. Name the tool you want to run.",
                    status="error",
                )
            inner_name = tool_args.get("name", "")
            inner_args = tool_args.get("arguments", {})
            if isinstance(inner_args, str):
                try:
                    inner_args = _json.loads(inner_args)
                except (ValueError, TypeError):
                    return ToolResult(
                        content="call_tool arguments were not valid JSON.",
                        status="error",
                    )
            if not isinstance(inner_args, dict):
                return ToolResult(
                    content="call_tool arguments must be an object.",
                    status="error",
                )
            if not inner_name:
                return ToolResult(content="call_tool requires a tool name.", status="error")
            return await self.execute_tool(inner_name, inner_args, context, _depth=_depth + 1)

        # Deferred tools: handle list_tools / search_tools / get_tool_schema via proxy
        proxy = getattr(self, "_deferred_proxy", None)
        if proxy and tool_name == "list_tools":
            page = tool_args.get("page", 1)
            content = await proxy.list_tools_page(page)
            return ToolResult(content=content)
        if proxy and tool_name == "search_tools":
            query = tool_args.get("query", "")
            content = await proxy.search_tools(query)
            return ToolResult(content=content)
        if proxy and tool_name == "get_tool_schema":
            name = tool_args.get("name", "")
            content = await proxy.get_tool_schema(name)
            return ToolResult(content=content)

        tool = self.tool_registry.get(tool_name)
        execution_location = "backend"

        # Check extra_tools if not found in registry (e.g. SubAgentTool adapters)
        if tool is None and hasattr(self, 'extra_tools') and self.extra_tools:
            for extra_tool in self.extra_tools:
                if extra_tool.name == tool_name:
                    tool = extra_tool
                    break

        client_tool_names = {
            t.get("function", {}).get("name", "") for t in (context.client_tools or [])
        }
        if tool is None and tool_name in client_tool_names:
            execution_location = "frontend"

        allowed_tools = self.capabilities.available_tools
        if allowed_tools is not None and tool_name not in allowed_tools:
            if not (tool and tool.built_in):
                logger.warning(f"Agent '{self.identity.name}' tried to use unavailable tool: {tool_name}")
                return ToolResult(content=f"Tool not available: {tool_name}", status="error")

        # The stored policy is the server's own decision and is applied first.
        # A "deny" is final and never reaches the client; an "allow" skips the
        # prompt; anything else has to be approved by a human.
        policy = (context.tool_policies or {}).get(tool_name)

        if policy == "deny":
            logger.info(
                "Tool '%s' refused for user %s by stored policy", tool_name, context.user_id,
            )
            return ToolResult(
                content=f"Tool execution denied by policy: {tool_name}",
                status="denied",
            )

        if tool:
            description = tool.describe_call(tool_args)
        else:
            description = f"Execute {tool_name} with args: {tool_args}"

        if policy != "allow":
            if not context.handler:
                # Nothing is attached that could approve this. Historically the
                # call went ahead unchecked; it must not.
                logger.warning(
                    "Refusing tool '%s': no client session available to approve it", tool_name,
                )
                return ToolResult(
                    content=f"Tool execution denied (no client available to approve): {tool_name}",
                    status="denied",
                )

            approval_request = ToolApprovalRequestEvent(
                tool_name=tool_name,
                tool_args=tool_args,
                agent_id=self.identity.id,
                name=self.identity.name,
                description=description,
                execution_location=execution_location,
            )

            response = await context.handler.request_tool_approval(approval_request)

            if not response.approved:
                return ToolResult(content=f"Tool execution denied by user: {tool_name}", status="denied")

            if response.modified_args:
                tool_args = response.modified_args

        exec_args = dict(tool_args)

        if context.conversation_id:
            exec_args["conversation_id"] = context.conversation_id
        if context.user_id:
            exec_args["user_id"] = context.user_id
        # Identity of the caller: the persona for a MainAgent, the sub-agent
        # itself for a SubAgent. Kept under the generic name because it is part
        # of the argument contract handed to client- and MCP-side tools.
        exec_args["agent_id"] = self.identity.id
        if context.handler:
            exec_args["_handler"] = context.handler
        exec_args["_context"] = context

        if execution_location == "frontend":
            if context.client_tool_callback:
                try:
                    result = await context.client_tool_callback(tool_name, tool_args)
                    return ToolResult.from_content(result)
                except Exception as e:
                    logger.error(f"Client tool execution failed: {e}", exc_info=True)
                    return ToolResult(content=f"Client tool execution failed: {e}", status="error")
            else:
                return ToolResult(content=f"No client tool callback for: {tool_name}", status="error")

        if tool:
            try:
                result = await tool.execute(exec_args)
                return ToolResult.from_content(result)
            except Exception as e:
                logger.error(f"Tool execution failed: {e}", exc_info=True)
                return ToolResult(content=f"Tool execution failed: {e}", status="error")
        elif context.user_id:
            return await self._execute_mcp_tool(tool_name, tool_args, context)
        else:
            return ToolResult(content=f"Unknown tool: {tool_name}", status="error")

    async def _execute_mcp_tool(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        context: AgentContext,
    ) -> ToolResult:
        """Execute a server-side MCP tool."""
        try:
            from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
            orchestrator = get_user_orchestrator(context.user_id)

            await orchestrator.get_tools()
            mcp_args = dict(tool_args)

            class MockToolCall:
                class Function:
                    def __init__(self, name, args):
                        self.name = name
                        self.arguments = args

                def __init__(self, name, args):
                    self.function = self.Function(name, args)

            mock_call = MockToolCall(tool_name, mcp_args)
            results = await orchestrator.execute_tool_calls(
                [mock_call],
                conversation_id=context.conversation_id,
            )

            if results:
                content = results[0].get("content", "")
                if content != "MCP client not available":
                    images = results[0].get("images") or []
                    return ToolResult.from_content(content, images=images)

        except Exception as e:
            logger.warning(f"Server MCP tool execution failed for '{tool_name}': {e}")

        return ToolResult(content=f"Unknown tool: {tool_name}", status="error")
