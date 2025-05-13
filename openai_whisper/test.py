import asyncio
import wave
import sys

import websockets

# === CONFIG ===
WS_URI      = "ws://localhost:8000/asr"
AUDIO_FILE  = "sample_1746930408.wav"
SAMPLE_RATE = 16000       # Hz
SAMPLE_WIDTH = 2           # bytes (16-bit)
CHANNELS    = 1            # mono
CHUNK_FRAMES = SAMPLE_RATE # send 1 s of audio per chunk

async def stream_and_transcribe(uri: str, wav_path: str):
    # Open and validate WAV
    wf = wave.open(wav_path, "rb")
    if (wf.getframerate() != SAMPLE_RATE or
        wf.getsampwidth() != SAMPLE_WIDTH or
        wf.getnchannels() != CHANNELS):
        print("ERROR: WAV must be 16 kHz, 16-bit, mono.", file=sys.stderr)
        return

    async with websockets.connect(uri) as ws:
        print(f"Connected to {uri}\nStreaming audio in {CHUNK_FRAMES/SAMPLE_RATE:.1f}s chunks…\n")
        # send chunks
        while True:
            data = wf.readframes(CHUNK_FRAMES)
            if not data:
                break
            await ws.send(data)

        # signal end-of-stream
        await ws.send("EOS")
        final = await ws.recv()
        print("\n✅ Final:", final)

if __name__ == "__main__":
    if not AUDIO_FILE:
        print("Set AUDIO_FILE to your .wav path", file=sys.stderr)
        sys.exit(1)
    asyncio.run(stream_and_transcribe(WS_URI, AUDIO_FILE))