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
    def __init__(self):
        self.server_uri = os.environ.get("ASSISANT_SERVER_URI", "ws://127.0.0.1:15597/chat")
        print(f"ASSISANT_SERVER_URI: {self.server_uri}")
        self.ws = websocket.create_connection(self.server_uri)
        self.keep_connection_thread = threading.Thread(target=self.keep_connection)
        self.keep_connection_thread.daemon = True
        self.keep_connection_thread.start()

    def execute_command(self, response):
        pattern = re.compile(r'```bash (flux_led.*?)```')
        match = pattern.search(response)
        if match:
            command = match.group(1)
            #print(f"Executing command: {command}")
            result = subprocess.run(command.split(" "), capture_output=True, text=True)
            #print(result.stdout)

    def keep_connection(self):
        while True:
            try:
                self.ws.send("PING")
                response = self.ws.recv()
            except Exception as e:
                print(f"Error: Cannot reach Assistant Server, retrying... Error: {e}")
                self.ws = websocket.create_connection(self.server_uri)
            time.sleep(10)

    def __call__(self, audio):
        self.ws.send(audio.tobytes())
        while True:
            response = self.ws.recv()
            json_response = json.loads(response)
            done = json_response.get("done")
            message = {"role": json_response.get("role"), "content": json_response.get("content")}

            audio = None
            if message["role"] == "assistant":
                audio = self.ws.recv()
                audio = np.frombuffer(response, dtype=np.int16)
                audio = audio.astype(np.float32) / 32768.0
                
            yield message, audio
            if done:
                return
