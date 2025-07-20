from fastmcp import Client
import sys
import os
async def list_tools(client):
    try:
        # Always use context manager to ensure proper connection
        async with client:
            mcp_tools = await client.list_tools()
            ollama_tools = [
                {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.inputSchema
                }
                }
                for t in mcp_tools
            ]
            return ollama_tools
    except Exception as e:
        print(f"Error listing MCP tools: {e}")
        return []
    
async def call_tool(client, name, arguments):
    try:
        async with client:
            return await client.call_tool(name, arguments)
    except Exception as e:
        print(f"Error calling MCP tool {name}: {e}")
        return {"error": str(e)}