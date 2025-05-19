import io
import os
import re
import subprocess
import threading
import time
import numpy as np
import requests
from dotenv import load_dotenv
import json
load_dotenv()

class Agent:
    def __init__(self, model_name = "gemma3:12b-it-qat"):
        if "LLM_API_URL" not in os.environ:
            print("\033[31mWarning: LLM_API_URL not set in environment. Using default value: http://127.0.0.1:11434/api/chat\033[0m")
        else:
            print(f"Using LLM API URL: {os.environ['LLM_API_URL']}")
        if "TTS_API_URL" not in os.environ:
            print("\033[31mWarning: TTS_API_URL not set in environment. Using default value: http://127.0.0.1:9880/tts\033[0m")
        else:
            print(f"Using TTS API URL: {os.environ['TTS_API_URL']}")

        if "ASR_API_URL" not in os.environ:
            print("\033[31mWarning: ASR_API_URL not set in environment. Using default value: ws://127.0.0.1:15597\033[0m")
        else:
            print(f"Using ASR API URL: {os.environ['ASR_API_URL']}")
            
        self.llm_api = os.environ.get("LLM_API_URL", "http://127.0.0.1:11434")
        self.llm_chat_api = f"{self.llm_api}/api/chat"
        self.tts_api = os.environ.get("TTS_API_URL", "http://127.0.0.1:9880/tts")
        self.model_name = model_name
        self.pull_model(model_name)
        self.conversation = []
        self.asr_api = os.environ.get("ASR_API_URL", "http://127.0.0.1:15597")
        self.CHUNK_FRAMES = 16000
        self.delimiter = set('.\n')
        with open("configs/default.json", "r", encoding="utf-8") as f:
            json_data = json.loads(f.read())
            self.template = json_data["system_prompts"]

    def execute_command(self, response):
        pattern = re.compile(r'```bash (flux_led.*?)```')
        match = pattern.search(response)
        if match:
            command = match.group(1)
            #print(f"Executing command: {command}")
            result = subprocess.run(command.split(" "), capture_output=True, text=True)
            #print(result.stdout)

    def process_and_say(self, message):
        self.conversation.append({'role': 'user', 'content': message})
        messages = self.template + self.conversation
        headers = {"Content-Type": "application/json"}
        json_body = {"model": self.model_name, "messages": messages, "stream": True}
        full_response = ""
        partial_response = ""
        chunk_response = ""
        with requests.post(self.llm_chat_api, headers=headers, json=json_body, stream=True) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8')
                    try:
                        json_line = json.loads(decoded_line)
                        full_response += json_line['message']['content']
                        partial_response += json_line['message']['content']
                        if (partial_response.count('`') !=6 and partial_response.count('`') != 0):
                            continue
                        if partial_response.count('`') == 6:
                            self.execute_command(partial_response)
                            partial_response = re.sub(r'```bash (flux_led.*?)```', '', partial_response)
                        
                        if json_line.get('done'):
                            chunk_response = partial_response
                            partial_response = None
                            voice_data = self.say(chunk_response)
                            yield chunk_response, voice_data
                        else:
                            for i, c in enumerate(partial_response):
                                if c in self.delimiter:
                                    chunk_response += partial_response[:i+1]
                                    partial_response = partial_response[i+1:]
                                    if len(chunk_response) >= 20:
                                        break
                                    
                            if len(chunk_response) >= 20:
                                voice_data = self.say(chunk_response)
                                yield chunk_response, voice_data
                                chunk_response = ""
                    except json.JSONDecodeError:
                        print(f"Error decoding JSON: {decoded_line}")

        self.conversation.append({'role': 'assistant', 'content': full_response})


    def transcribe(self, audio_array):
        try:
            resp = requests.post(
                self.asr_api,
                headers={"Content-Type": "application/octet-stream"},
                data=audio_array.tobytes(),
            )
            resp.raise_for_status()
        except Exception as e:
            print(f"Error: {e}")
            return None
        
        return resp.json()['text']

    def reset_state(self):
        self.conversation = []

    def say(self, text):
        if text is None or len(text) == 0:
            return
        
        text = re.sub(r'```bash (flux_led.*?)```', '', text)
        json_body = {"text": text}
        try:
            response = requests.post(self.tts_api, json=json_body)
            response.raise_for_status()
        except Exception as e:
            print(f"TTS Error: {e}")
            return
        
        audio_data = response.content
        audio_stream = io.BytesIO(audio_data)
        audio_array = np.frombuffer(audio_stream.read(), dtype=np.int16)
        return audio_array

    def process_message(self, message) -> str:
        self.conversation.append({'role': 'user', 'content': message})
        messages = self.template + self.conversation

        json_body = {"model": self.model_name, "messages": messages, "stream": False}

        try:
            response = requests.post(
                self.llm_chat_api,
                json=json_body,
            )
            response.raise_for_status()
        except Exception as e:
            print(f"Error: {e}")
            return

        response = response.json()['message']["content"]
        self.conversation.append({'role': 'assistant', 'content': response})
        return response
    
    def pull_model(self, model_name):
        # send http request to ollama serivce and check whether there exist the model name or not, if not pull it

        try:
            response = requests.get(f"{self.llm_api}/api/tags")
            response.raise_for_status()
        except Exception as e:
            print(f"Error: {e}")
            raise e
        
        response = response.json()
        models = [tag['name'] for tag in response['models']]
        if model_name not in models:
            print(f"Model {model_name} not found in Ollama. Pulling...")
        
            json_body = {"model": model_name, "stream": False}
            try:
                response = requests.post(f"{self.llm_api}/api/pull", json=json_body)
                response.raise_for_status()
            except Exception as e:
                print(f"Error: {e}")
                raise e
            response = response.json()
            if response['status'] == 'success':
                print(f"Model {model_name} pulled successfully.")

        print(f"{model_name} is ready to use.")