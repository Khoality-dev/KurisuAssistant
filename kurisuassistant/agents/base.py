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


def estimate_tokens(text: str) -> int:
    """Estimate token count from text (words * 1.3 approximation)."""
    if not text:
        return 0
    return int(len(text.split()) * 1.3)


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
class AgentConfig:
    """Configuration shared by MainAgent and SubAgent.

    MainAgent requires identity fields (voice_reference, avatar_uuid,
    character_config, preferred_name, trigger_word). SubAgent ignores them.
    """
    id: Optional[int] = None
    name: str = ""
    description: str = ""
    system_prompt: str = ""

    # Identity (MainAgent only)
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[Dict] = None
    preferred_name: Optional[str] = None

    # Inference config
    model_name: Optional[str] = None
    provider_type: str = "ollama"
    available_tools: Optional[List[str]] = None  # None = all tools
    think: bool = False
    use_deferred_tools: bool = False

    # State
    agent_type: str = "main"  # 'main' or 'sub'
    memory: Optional[str] = None
    memory_enabled: bool = True
    enabled: bool = True
    is_system: bool = False


@dataclass
class AgentContext:
    """Context passed to agent during processing."""
    user_id: int = 0
    conversation_id: int = 0
    frame_id: int = 0
    model_name: str = ""
    handler: Optional["ChatSessionHandler"] = None
    available_agents: List[AgentConfig] = field(default_factory=list)
    user_system_prompt: str = ""
    preferred_name: str = ""
    api_url: Optional[str] = None
    gemini_api_key: Optional[str] = None
    nvidia_api_key: Optional[str] = None
    client_tools: List[Dict] = field(default_factory=list)
    client_tool_callback: Optional[Callable[[str, Dict], Coroutine[Any, Any, str]]] = None
    images: Optional[List[str]] = None
    context_size: Optional[int] = None
    compacted_context: str = ""


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

    def __init__(self, config: AgentConfig, tool_registry: ToolRegistry):
        self.config = config
        self.tool_registry = tool_registry

    async def execute_tool(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        context: AgentContext,
    ) -> ToolResult:
        """Execute a tool after requesting approval from frontend.

        All tool calls go through frontend for permission check. Frontend
        decides whether to auto-approve based on the user's policies or
        show an approval dialog.
        """
        import json as _json

        # Deferred tools: intercept call_tool and delegate to the inner tool
        if tool_name == "call_tool":
            inner_name = tool_args.get("name", "")
            inner_args = tool_args.get("arguments", {})
            if isinstance(inner_args, str):
                inner_args = _json.loads(inner_args)
            return await self.execute_tool(inner_name, inner_args, context)

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

        if self.config.available_tools is not None and tool_name not in self.config.available_tools:
            if not (tool and tool.built_in):
                logger.warning(f"Agent '{self.config.name}' tried to use unavailable tool: {tool_name}")
                return ToolResult(content=f"Tool not available: {tool_name}", status="error")

        if tool:
            description = tool.describe_call(tool_args)
        else:
            description = f"Execute {tool_name} with args: {tool_args}"

        # ALWAYS request approval from frontend
        if context.handler:
            approval_request = ToolApprovalRequestEvent(
                tool_name=tool_name,
                tool_args=tool_args,
                agent_id=self.config.id,
                name=self.config.name,
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
        exec_args["agent_id"] = self.config.id
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
