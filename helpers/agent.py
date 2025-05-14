import io
import os
import threading
import time
import numpy as np
import requests
from dotenv import load_dotenv
import json
import websocket
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
        self.tts_api = os.environ.get("TTS_API_URL", "http://10.0.0.122:9880/tts")
        self.model_name = model_name
        self.pull_model(model_name)
        self.conversation = []
        self.asr_api = os.environ.get("ASR_API_URL", "ws://127.0.0.1:15597")
        self.asr_ws = websocket.create_connection(self.asr_api)
        if self.asr_ws.status != 101:
            print(f"Error: {self.asr_ws.status_code}")
            raise Exception("Error connecting to ASR API")
        self.asr_ping_thread = threading.Thread(target=self.asr_ping)
        self.asr_ping_thread.daemon = True
        self.asr_ping_thread.start()
        self.CHUNK_FRAMES = 16000
        with open("configs/default.json", "r", encoding="utf-8") as f:
            json_data = json.loads(f.read())
            self.template = json_data["system_prompts"]

    def asr_ping(self):
        while True:
            self.asr_ws.send("PING")
            response = self.asr_ws.recv()
            time.sleep(10)

    def transcribe(self, audio_array):
        try:
            while len(audio_array) > 0:
                data = audio_array[:self.CHUNK_FRAMES]
                audio_array = audio_array[self.CHUNK_FRAMES:]
                self.asr_ws.send_binary(data.tobytes())
        except Exception as e:
            print(f"Error: {e}")

    def reset_state(self):
        self.conversation = []

    def say(self, text):
        if text is None or len(text) == 0:
            return
        
        params = {
            "text_lang": "ja",
            "ref_audio_path": "reference/ayaka_ref.wav",
            "prompt_lang": "ja",
            "text_split_method": "cut5",
            "batch_size": 20,
            "media_type": "wav",
            "streaming_mode": True,
        }
        params['text'] = text
        try:
            response = requests.get(self.tts_api, params=params)
            response.raise_for_status()
        except Exception as e:
            print(f"Error: {e}")
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