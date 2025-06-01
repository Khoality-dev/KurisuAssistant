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
import websocket
load_dotenv()

class Agent:
    def __init__(self, model_name = "gemma3:12b-it-qat-tool"):
        if "WS_API_URL" not in os.environ:
            print("\033[31mWarning: WS_API_URL not set in environment.")

        self.websocket_api = os.environ.get('WS_API_URL', "ws://localhost:11434/ws")
        print(f"Using WS API URL: {self.websocket_api}")
        self.model_name = model_name
        self.authentication_token = os.environ.get('AUTHENTICATION_TOKEN', "")
        #self.pull_model(model_name)
        self.CHUNK_FRAMES = 16000
        self.delimiter = set('.\n')
        self.m_lock = threading.Lock()
        self.websocket = websocket.create_connection(self.websocket_api, timeout=9999, ping_interval=10, ping_timeout=9999)
        self.websocket.send(self.authentication_token, opcode=websocket.ABNF.OPCODE_TEXT)
        
        self.check_connection_thread = threading.Thread(target=self.check_connection_loop)
        self.check_connection_thread.start()

    

    def check_connection_loop(self):
        while True:
            if not self.websocket.connected:
                with self.m_lock:
                    self.websocket.connect(self.websocket_api)
                    self.websocket.send(self.authentication_token, opcode=websocket.ABNF.OPCODE_TEXT)
                print("Reconnected.")
            time.sleep(3)


    def process_and_say(self, message):
        json_body = {"model": self.model_name, "message": {"role": "user", "content": message}, "stream": True}
        try:
            self.websocket.send(json.dumps(json_body), opcode=websocket.ABNF.OPCODE_TEXT)

            while True:
                with self.m_lock:
                    text_response = self.websocket.recv()
                json_data = json.loads(text_response)
                with self.m_lock:
                    audio_data = self.websocket.recv()
                if len(audio_data) != 0:
                    audio_stream = io.BytesIO(audio_data)
                    audio_array = np.frombuffer(audio_stream.read(), dtype=np.int16)
                else:
                    audio_array = None
                yield json_data['message']['content'], audio_array
                if json_data['done']:
                    break
        except Exception as e:
            print(f"Error: {e}")
        
        return

    def transcribe(self, audio_array):
        try:
            with self.m_lock:
                self.websocket.send(audio_array.tobytes(), opcode=websocket.ABNF.OPCODE_BINARY)
                text_response = self.websocket.recv()
            json_data = json.loads(text_response)
            return json_data['text']
        except Exception as e:
            print(f"Error: {e}")
        return None

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