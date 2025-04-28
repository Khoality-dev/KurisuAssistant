import torch
import whisper
import sounddevice as sd
import numpy as np
import webrtcvad
import collections
import threading
import time
import noisereduce as nr



# Settings
sample_rate = 16000  # Whisper and VAD both use 16 kHz
block_duration = 0.03  # 30 ms (must be 10, 20, or 30 ms)
block_size = int(sample_rate * block_duration)  # Samples per block
vad = webrtcvad.Vad(3)  # Aggressiveness
input_device, output_device = sd.default.device
devices = sd.query_devices()

print("Current input device:")
print(f"  Index: {input_device}")
print(f"  Name: {devices[input_device]['name']}")
print()
print("Current output device:")
print(f"  Index: {output_device}")
print(f"  Name: {devices[output_device]['name']}")
# Load Whisper model
model = whisper.load_model("base")  # or "base", "small", etc.

def record_and_detect():
    """ Continuously listen and collect speech when VAD detects voice. """
    print("Listening for speech (Ctrl+C to stop)...")

    buffer = collections.deque()
    speaking = False
    recording = []
    last_voice_time = time.time()

    def callback(indata, frames, time_info, status):
        nonlocal speaking, recording, last_voice_time

        audio = indata[:, 0].copy()
        pcm_data = (audio * 32768).astype(np.int16).tobytes()
        is_speech = vad.is_speech(pcm_data, sample_rate)
        if is_speech:
            last_voice_time = time.time()
            if not speaking:
                print("Started speaking...")
                speaking = True
            recording.append(audio)
        else:
            if speaking and time.time() - last_voice_time > 1 and len(recording) > 0:
                
                audio_array = np.concatenate(recording).copy()
                recording.clear()
                threading.Thread(target=transcribe_audio, args=(audio_array,)).start()
                speaking = False
                print("Stopped speaking. Transcribing...")

    with sd.InputStream(channels=1, samplerate=sample_rate, blocksize=block_size, dtype='float32', callback=callback):
        while True:
            time.sleep(0.1)

def transcribe_audio(audio):
    """ Transcribe the captured audio """
    if len(audio) == 0:
        return
    audio = nr.reduce_noise(y=audio, sr=sample_rate)
    # play the audio to the speaker
    sd.play(audio, samplerate=sample_rate)
    sd.wait()
    # Convert back to tensor
    result = model.transcribe(audio, fp16=False, initial_prompt="Names: Kurisu, Khoa", language="en")
    print("Transcription:", result["text"])

if __name__ == "__main__":
    try:
        record_and_detect()
    except KeyboardInterrupt:
        print("\nStopped.")