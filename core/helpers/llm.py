import json
import os
from ollama import Client
from mcp_tools.client import list_tools, call_tool


class LLM:
    def __init__(self, mcp_client):
        self.api_url = os.getenv("LLM_API_URL", "http://127.0.0.1:11434")
        print(f"LLM API URL: {self.api_url}")
        self.delimiters = ['.', '\n', '?']
        self.client = Client(host=self.api_url)
        with open("configs/default.json", "r") as f:
            json_config = json.load(f)
            self.system_prompts = json_config.get("system_prompts", [])
            self.mcp_configs = {
                "mcpServers": json_config.get("mcp_servers", {})
            }
        self.mcp_client = mcp_client
        self.history = []
        
    def pull_model(self, model_name):
        self.client.pull(model_name)

    async def __call__(self, payload):

        full_response = ""
        response_buffer = ""
        partial_response = ""
        is_final = False
        json_response = None
        self.history.append(payload['message'])
        while not is_final:
            is_final = True
            tools = await list_tools(self.mcp_client)
            
            messages = self.system_prompts + self.history
            stream = self.client.chat(model = payload['model'], messages=messages, stream = payload['stream'], tools=tools)
            for chunk in stream:
                json_response = chunk.dict()
                print(json_response)
                if chunk.message.tool_calls is not None:
                    for tool_call in chunk.message.tool_calls:
                        result = await call_tool(self.mcp_client, tool_call.function.name, tool_call.function.arguments)
                        json_tool_response = {"text": result[0].text}
                        self.history.append({"role": "user", "content": f"<tool_response> {json.dumps(json_tool_response)} </tool_response>"})
                        print(self.history[-1])
                    is_final = False
                
                if is_final:
                    full_response += chunk.message.content
                    #full_response = re.sub(r'<think>.*?</think>', '', full_response, flags=re.DOTALL)
                    partial_response += chunk.message.content

                    delimiter_idx = max([partial_response.rfind(delimiter) for delimiter in self.delimiters])
                    if delimiter_idx != -1:
                        response_buffer += partial_response[:delimiter_idx+1]
                        partial_response = partial_response[delimiter_idx+1:]
                    elif chunk['done']:
                        response_buffer += partial_response
                        partial_response = ""
                    
                    if (len(response_buffer) > 20 or chunk['done']):
                        json_response['message']['content'] = response_buffer
                        yield json_response
                        response_buffer = ""
                    
        self.history.append({"role": "assistant", "content": full_response})
        print(self.history[-1])