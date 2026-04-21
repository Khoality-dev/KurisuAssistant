"""Deferred tool system — 3 stable meta-tools that preserve Ollama KV cache.

Instead of passing all tool schemas upfront (which bloats the prefix and
invalidates KV cache when tools change), we pass exactly 3 meta-tools:
  1. list_tools  — paginated tool discovery (name + description)
  2. get_tool_schema — full parameter schema for a specific tool
  3. call_tool — execute any tool by name

The LLM discovers tools on demand: list_tools -> get_tool_schema -> call_tool.
"""

import json
import logging
import math
from typing import Any, Callable, Coroutine, Dict, List, Optional

from .base import BaseTool

logger = logging.getLogger(__name__)

PAGE_SIZE = 20

# Meta-tool names — used for interception in execute_tool()
META_TOOL_NAMES = frozenset({"list_tools", "search_tools", "get_tool_schema", "call_tool"})


class DeferredToolProxy:
    """Collects tools from all sources and serves them to meta-tools."""

    def __init__(
        self,
        tool_registry: "ToolRegistry",
        available_tools: Optional[set],
        user_id: Optional[int],
        client_tools: List[Dict],
    ):
        self._registry = tool_registry
        self._allowed = available_tools  # None = all tools
        self._user_id = user_id
        self._client_tools = client_tools
        # Cache built once per agent turn
        self._catalog: Optional[List[Dict[str, str]]] = None

    async def _build_catalog(self) -> List[Dict[str, str]]:
        """Build unified tool catalog from all sources."""
        if self._catalog is not None:
            return self._catalog

        catalog = []

        # Native tools (skip built-in — they're in the tools param directly)
        for name, tool in self._registry._tools.items():
            if tool.built_in:
                continue
            if self._allowed is not None and name not in self._allowed:
                continue
            if name in META_TOOL_NAMES:
                continue
            schema = tool.get_schema()
            fn = schema.get("function", {})
            catalog.append({
                "name": fn.get("name", name),
                "description": fn.get("description", ""),
                "source": "native",
            })

        # MCP tools
        if self._user_id:
            try:
                from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
                mcp_tools = await get_user_orchestrator(self._user_id).get_tools()
                for t in mcp_tools:
                    fn = t.get("function", {})
                    tool_name = fn.get("name", "")
                    if self._allowed is not None and tool_name not in self._allowed:
                        continue
                    catalog.append({
                        "name": tool_name,
                        "description": fn.get("description", ""),
                        "source": "mcp",
                    })
            except Exception as e:
                logger.warning(f"Failed to load MCP tools for catalog: {e}")

        # Client tools
        for t in self._client_tools:
            fn = t.get("function", {})
            tool_name = fn.get("name", "")
            if self._allowed is not None and tool_name not in self._allowed:
                continue
            catalog.append({
                "name": tool_name,
                "description": fn.get("description", ""),
                "source": "client",
            })

        self._catalog = catalog
        return catalog

    async def list_tools_page(self, page: int = 1) -> str:
        """Return a paginated list of tool names and descriptions."""
        catalog = await self._build_catalog()
        total = len(catalog)
        total_pages = max(1, math.ceil(total / PAGE_SIZE))
        page = max(1, page)

        if page > total_pages:
            return f"No more tools. Last page is {total_pages}. ({total} tools total)"

        start = (page - 1) * PAGE_SIZE
        end = start + PAGE_SIZE
        items = catalog[start:end]

        lines = [f"**Tools** (page {page}/{total_pages}, {total} total)\n"]
        for t in items:
            lines.append(f"- **{t['name']}**: {t['description']}")
        return "\n".join(lines)

    async def search_tools(self, query: str) -> str:
        """Search tools by keyword in name or description."""
        catalog = await self._build_catalog()
        query_lower = query.lower()
        matches = [
            t for t in catalog
            if query_lower in t["name"].lower() or query_lower in t["description"].lower()
        ]
        if not matches:
            return f"No tools found matching \"{query}\"."
        lines = [f"**Search results for \"{query}\"** ({len(matches)} found)\n"]
        for t in matches:
            lines.append(f"- **{t['name']}**: {t['description']}")
        return "\n".join(lines)

    async def get_tool_schema(self, name: str) -> str:
        """Return the full schema for a specific tool."""
        def _is_allowed(tool_name: str, built_in: bool = False) -> bool:
            return self._allowed is None or tool_name in self._allowed or built_in

        # Native tool
        tool = self._registry.get(name)
        if tool and name not in META_TOOL_NAMES:
            if _is_allowed(name, tool.built_in):
                return json.dumps(tool.get_schema(), indent=2)

        # MCP tools
        if self._user_id:
            try:
                from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
                mcp_tools = await get_user_orchestrator(self._user_id).get_tools()
                for t in mcp_tools:
                    fn = t.get("function", {})
                    if fn.get("name") == name and _is_allowed(name):
                        return json.dumps(t, indent=2)
            except Exception as e:
                logger.warning(f"Failed to load MCP tool schema: {e}")

        # Client tools
        for t in self._client_tools:
            fn = t.get("function", {})
            if fn.get("name") == name and _is_allowed(name):
                return json.dumps(t, indent=2)

        return f"Error: Tool not found: {name}"

    async def tool_exists(self, name: str) -> bool:
        """Check if a tool exists in the catalog."""
        catalog = await self._build_catalog()
        return any(t["name"] == name for t in catalog)


class ListToolsTool(BaseTool):
    """Meta-tool: list available tools with pagination."""

    name = "list_tools"
    description = "List available tools with their names and descriptions. Returns a paginated list."
    built_in = True

    def __init__(self, proxy: DeferredToolProxy):
        self.proxy = proxy

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "page": {
                            "type": "integer",
                            "description": "Page number (default 1)",
                        },
                    },
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        page = args.get("page", 1)
        return await self.proxy.list_tools_page(page)


class SearchToolsTool(BaseTool):
    """Meta-tool: search tools by keyword."""

    name = "search_tools"
    description = "Search available tools by keyword in name or description."
    built_in = True

    def __init__(self, proxy: DeferredToolProxy):
        self.proxy = proxy

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
                            "description": "Keyword to search for in tool names and descriptions",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        query = args.get("query", "")
        return await self.proxy.search_tools(query)


class GetToolSchemaTool(BaseTool):
    """Meta-tool: get full parameter schema for a specific tool."""

    name = "get_tool_schema"
    description = "Get the full parameter schema for a tool. Call this before call_tool to know the expected arguments."
    built_in = True

    def __init__(self, proxy: DeferredToolProxy):
        self.proxy = proxy

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "The tool name to look up",
                        },
                    },
                    "required": ["name"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        name = args.get("name", "")
        return await self.proxy.get_tool_schema(name)


class CallToolTool(BaseTool):
    """Meta-tool: execute any discovered tool by name."""

    name = "call_tool"
    description = "Execute a tool by name with the given arguments. Use get_tool_schema first to know the expected arguments."
    built_in = True

    def __init__(self, proxy: DeferredToolProxy):
        self.proxy = proxy

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "The tool name to execute",
                        },
                        "arguments": {
                            "type": "object",
                            "description": "Arguments to pass to the tool",
                        },
                    },
                    "required": ["name", "arguments"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        # Execution is intercepted by BaseAgent.execute_tool() — this is a fallback
        return "Error: call_tool must be executed through the agent"


def create_deferred_tools(
    tool_registry: "ToolRegistry",
    available_tools: Optional[set],
    user_id: Optional[int],
    client_tools: List[Dict],
) -> tuple["DeferredToolProxy", List[BaseTool]]:
    """Create the meta-tools wired to a shared DeferredToolProxy.

    Returns:
        (proxy, [list_tools, search_tools, get_tool_schema, call_tool])
    """
    proxy = DeferredToolProxy(
        tool_registry=tool_registry,
        available_tools=available_tools,
        user_id=user_id,
        client_tools=client_tools,
    )
    return proxy, [
        ListToolsTool(proxy),
        SearchToolsTool(proxy),
        GetToolSchemaTool(proxy),
        CallToolTool(proxy),
    ]
