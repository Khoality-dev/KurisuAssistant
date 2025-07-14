import os
import json
import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()

class Agent:
    def __init__(self, model_name: str = "gemma3:12b-it-qat-tool"):
        self.llm_api = os.environ.get("LLM_HUB_URL", "http://localhost:15597")
        self.tts_api = os.environ.get("TTS_HUB_URL", "http://localhost:15598")
        self.model_name = model_name
        self.session = requests.Session()
        self.CHUNK_FRAMES = 16000
        self.delimiter = set('.\n')

    def process_and_say(self, message):
        json_body = {
            "model": self.model_name,
            "message": {"role": "user", "content": message},
            "stream": True,
        }
        try:
            response = self.session.post(f"{self.llm_api}/chat", json=json_body, stream=True)
            for line in response.iter_lines():
                if not line:
                    continue
                json_data = json.loads(line.decode())
                text = json_data["message"]["content"]
                tts_resp = self.session.post(f"{self.tts_api}/tts", json={"text": text})
                audio_data = tts_resp.content if tts_resp.ok else b''
                audio_array = np.frombuffer(audio_data, dtype=np.int16) if audio_data else None
                yield text, audio_array
                if json_data.get("done"):
                    break
        except Exception as e:
            print(f"Error: {e}")
        finally:
            response.close()

    def transcribe(self, audio_array):
        try:
            resp = self.session.post(f"{self.llm_api}/asr", data=audio_array.tobytes())
            resp.raise_for_status()
            json_data = resp.json()
            return json_data.get("text")
        except Exception as e:
            print(f"Error: {e}")
        return None
