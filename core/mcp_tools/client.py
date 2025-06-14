from fastmcp import Client


async def list_tools(client):
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
    
async def call_tool(client, name, arguments):
    async with client:
        return await client.call_tool(name, arguments)