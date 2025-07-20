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
    
async def call_tool(client, name, arguments, conversation_id=None):
    try:
        # Inject conversation_id for mcp-context tools
        if conversation_id is not None and name in [
            "mcp-context_retrieve_messages_by_date_range", 
            "mcp-context_retrieve_messages_by_regex", 
            "mcp-context_get_conversation_summary"
        ]:
            if isinstance(arguments, dict):
                arguments["conversation_id"] = conversation_id
            elif isinstance(arguments, str):
                import json
                try:
                    args_dict = json.loads(arguments)
                    args_dict["conversation_id"] = conversation_id
                    arguments = json.dumps(args_dict)
                except json.JSONDecodeError:
                    print(f"Warning: Could not parse arguments for tool {name}")
        
        async with client:
            return await client.call_tool(name, arguments)
    except Exception as e:
        print(f"Error calling MCP tool {name}: {e}")
        return {"error": str(e)}