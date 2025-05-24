import json
import os
import re
import subprocess
import requests

class LLM:
    def __init__(self):
        self.api_url = os.getenv("LLM_API_URL", "http://127.0.0.1:11434")
        print(f"LLM API URL: {self.api_url}")
        self.delimiter = set(['.', '\n', '?'])

    def check_for_command(self, message):
        pattern = re.compile(r'```bash\s*(.*?)\s*```', re.DOTALL)
        match = pattern.search(message)
        if match:
            flux_led_command = match.group(1)
            print("Found flux_led command: ", flux_led_command)
            result = subprocess.run(flux_led_command.split(" "), capture_output=True, text=True)
            message = re.sub(pattern, "", message)
        return message

    def __call__(self, payload):
        resp = requests.post(self.api_url + "/api/chat", json=payload, stream=True)
        
        def stream_generator():
            full_response = ""
            partial_response = ""
            chunk_response = ""
            for line in resp.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8')
                    try:
                        json_line = json.loads(decoded_line)
                        full_response += json_line['message']['content']
                        partial_response += json_line['message']['content']
                        if (partial_response.count('`')%6 != 0):
                            continue
                        
                        partial_response = self.check_for_command(partial_response)
                        if json_line.get('done'):
                            chunk_response = partial_response
                            partial_response = ""
                            json_response = json_line.copy()
                            json_response["message"]["content"] = chunk_response
                            if chunk_response != "":
                                yield str(json_response) + "\n"
                        else:
                            for i, c in enumerate(partial_response):
                                if c in self.delimiter:
                                    chunk_response += partial_response[:i+1]
                                    partial_response = partial_response[i+1:]
                                    if len(chunk_response) >= 20:
                                        break
                                    
                            if len(chunk_response) >= 20:
                                json_response = json_line.copy()
                                json_response["message"]["content"] = chunk_response
                                if chunk_response != "":
                                    yield str(json_response) + "\n"
                                chunk_response = ""
                    except json.JSONDecodeError:
                        raise HTTPException(status_code=500, detail=f"Error decoding JSON: {decoded_line}")
            print(full_response)

        return stream_generator()
        