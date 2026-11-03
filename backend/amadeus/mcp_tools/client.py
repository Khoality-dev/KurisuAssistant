import logging

logger = logging.getLogger(__name__)


def _read_only_hint(tool) -> bool:
    """The tool's own readOnlyHint annotation; a tool that says nothing changes something."""
    annotations = getattr(tool, "annotations", None)
    return bool(getattr(annotations, "readOnlyHint", False)) if annotations is not None else False


async def list_tools(client):
    try:
        async with client:
            mcp_tools = await client.list_tools()
            return [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.inputSchema,
                    },
                    # Not part of the schema: the orchestrator takes it off before
                    # the schema reaches a model (#360).
                    "read_only": _read_only_hint(t),
                }
                for t in mcp_tools
            ]
    except Exception as e:
        logger.error(f"Error listing MCP tools: {e}")
        return []


async def call_tool(client, name, arguments):
    try:
        async with client:
            return await client.call_tool(name, arguments)
    except Exception as e:
        logger.error(f"Error calling MCP tool {name}: {e}")

        class ErrorResult:
            def __init__(self, error_msg):
                self.text = f"Error calling tool {name}: {error_msg}"

        return [ErrorResult(str(e))]
