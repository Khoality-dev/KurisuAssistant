import asyncio
import json
import wave
import sys
import sounddevice as sd
import numpy as np
import websocket

# === CONFIG ===
WS_URI      = "ws://localhost:15597/chat"
AUDIO_FILE  = "sample_1746930422.wav"
SAMPLE_RATE = 16000       # Hz
SAMPLE_WIDTH = 2           # bytes (16-bit)
CHANNELS    = 1            # mono
CHUNK_FRAMES = SAMPLE_RATE # send 1 s of audio per chunk


def main_wav(uri: str, wav_path: str):
    # Open and validate WAV
    wf = wave.open(wav_path, "rb")
    if (wf.getframerate() != SAMPLE_RATE or
        wf.getsampwidth() != SAMPLE_WIDTH or
        wf.getnchannels() != CHANNELS):
        print("ERROR: WAV must be 16 kHz, 16-bit, mono.", file=sys.stderr)
        return

    ws = websocket.create_connection(uri)

    print(f"Connected to {uri}\nStreaming audio in {CHUNK_FRAMES/SAMPLE_RATE:.1f}s chunks…\n")
    while True:
        data = wf.readframes(CHUNK_FRAMES)
        if not data:
            break
        ws.send_binary(data)
    
    ws.send_text("EOS")

    audios = []
    # check if it is text or binary
    while True:
        response = ws.recv()
        if isinstance(response, str):
            print(f"Received text: {response}")
            if response == "EOS":
                break
        else:
            audios.append(np.frombuffer(response, dtype=np.int16))
        
    
    sd.play(np.concatenate(audios), 32000)
    sd.wait()

def main_text(uri: str, text: str):
    ws = websocket.create_connection(uri)

    json_msg = {"text": text}
    ws.send_text(json.dumps(json_msg))
    print(f"Connected to {uri}\nStreaming text: {text}\n")

    audios = []
    while True:
        response = ws.recv()
        if isinstance(response, str):
            if response == "EOS":
                break
            print(f"Received text: {response}")
            
        else:
            audios.append(np.frombuffer(response, dtype=np.int16))
        
    
    sd.play(np.concatenate(audios), 32000)
    sd.wait()

if __name__ == "__main__":
    if not AUDIO_FILE:
        print("Set AUDIO_FILE to your .wav path", file=sys.stderr)
        sys.exit(1)
    main_text(WS_URI, "Hello, world!")