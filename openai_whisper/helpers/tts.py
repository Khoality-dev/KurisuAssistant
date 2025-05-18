import os
import requests


class TTS:
    def __init__(self):
        self.api_url = os.getenv("TTS_API_URL", "http://127.0.0.1:9880/tts")
        print(f"TTS API URL: {self.api_url}")
    def __call__(self, text: str) -> bytes:
        try:
            params = {
                "text": text,
                "text_lang": "ja",
                "ref_audio_path": "reference/ayaka_ref.wav",
                "prompt_lang": "ja",
                "text_split_method": "cut5",
                "batch_size": 20,
                "media_type": "wav",
                "streaming_mode": True,
            }
            response = requests.get(self.api_url, params=params)
            print(f"TTS Response: {response}")
            response.raise_for_status()
        except Exception as e:
            print(f"TTS Error: {e}")
            return None
        
        return response.content