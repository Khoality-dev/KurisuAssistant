import os
import re
import subprocess
import wave
import torch
import sounddevice as sd
import numpy as np
import time
import noisereduce as nr
from helpers.utils import pretty_print
from helpers.agent import Agent
from transformers import pipeline

print("Initializing...")
vad_model, utils = torch.hub.load(
    repo_or_dir='snakers4/silero-vad',
    model='silero_vad',
    force_reload=False
)
(get_speech_timestamps, save_audio, read_audio, VADIterator, collect_chunks) = utils
vad_iterator = VADIterator(vad_model)

# Settings
sample_rate = 16000  # Whisper and VAD both use 16 kHz
block_duration = 0.03  # 30 ms (must be 10, 20, or 30 ms)
block_size = int(sample_rate * block_duration)  # Samples per block
input_device, output_device = sd.default.device
devices = sd.query_devices()
VAD_FIXED_WINDOW_SIZE = 512           # e.g., 1024-sample window (~64ms)
RECORD_WINDOW_SIZE = 16000           # e.g., 16000-sample window (1 second)
min_speech_silence_s = 2          # 2s of silence to end utterance
torch_device = 'cuda' if torch.cuda.is_available() else 'cpu'

feedback_volume = 0.5
start_feedback_effect =  wave.open("assets/start_effect.wav")
start_feedback_effect = (np.frombuffer(start_feedback_effect.readframes(-1), dtype=np.int16).reshape((-1, 2)) * feedback_volume).astype(np.int16)
stop_feedback_effect =  wave.open("assets/stop_effect.wav")
stop_feedback_effect = (np.frombuffer(stop_feedback_effect.readframes(-1), dtype=np.int16).reshape((-1, 2)) * feedback_volume).astype(np.int16)
last_voice_time = time.time()

kurisu_agent = Agent()

print("Current input device:")
print(f"  Index: {input_device}")
print(f"  Name: {devices[input_device]['name']}")
print()
print("Current output device:")
print(f"  Index: {output_device}")
print(f"  Name: {devices[output_device]['name']}")

# Load Whisper model
whisper_model_name = 'whisper-finetuned' if os.path.exists('whisper-finetuned') else 'openai/whisper-base'
asr = pipeline(
    model=whisper_model_name,
    task='automatic-speech-recognition',
    device='cuda',
)

audio_buffer = np.array([], dtype=np.float32)
def record_and_detect():
    """ Continuously listen and collect speech when VAD detects voice. """
    print("Ready to take command...")
    speaking = False
    
    with sd.InputStream(channels=1, samplerate=sample_rate, blocksize=block_size, dtype='float32') as stream:
        audio_data = np.zeros((0, 1), dtype=np.float32)
        recording = np.zeros((0, 1), dtype=np.float32)
        last_voice_time = -1
        while True:
            block, overflowed = stream.read(block_size)
            if overflowed:
                print("Warning: input overflow")
            audio_data = np.concatenate((audio_data, block.copy()))
            recording = np.concatenate((recording, block.copy()))

            if len(audio_data) >= VAD_FIXED_WINDOW_SIZE:
                input_data = audio_data[:VAD_FIXED_WINDOW_SIZE]
                audio_data = audio_data[VAD_FIXED_WINDOW_SIZE:]
                speech = vad_iterator(input_data.flatten(), return_seconds=False)
                
                if speech is not None:
                    if 'start' in speech:
                        speaking = True
                        if last_voice_time == -1:
                            sd.play(start_feedback_effect.flatten())

                    if 'end' in speech:
                        last_voice_time = time.time()
                        speaking = False

            if not speaking and last_voice_time != -1 and (time.time() - last_voice_time) > min_speech_silence_s:
                segment = recording.copy()
                recording = np.zeros((0, 1), dtype=np.float32)
                sd.play(stop_feedback_effect.flatten(), blocking=True)
                #threading.Thread(target=transcribe_audio, args=(segment,)).start()
                transcribe_audio(segment)
                last_voice_time = -1
                

            if not speaking and last_voice_time == -1:
                if len(recording) > RECORD_WINDOW_SIZE:
                    recording = recording[-RECORD_WINDOW_SIZE:]
def transcribe_audio(audio):
    """ Transcribe the captured audio """
    if len(audio) == 0:
        return
    ## debug: playback the recording
    # audio = nr.reduce_noise(y=audio, sr=sample_rate)
    # play the audio to the speaker
    # sd.play((audio.flatten() * 32768).astype(np.int16), samplerate=sample_rate)
    # sd.wait()
    transcript = kurisu_agent.transcribe((audio.flatten() * 32768).astype(np.int16))
    if transcript is None:
        return
    pretty_print("User", transcript, delay=0.05)
    pretty_print("Kurisu", "Thinking...")
    response = kurisu_agent.process_message(transcript)
    if response is not None:
        # filter out the command before produce tts
        tts_input = re.sub(r'```bash (flux_led.*?)```', '', response)
        en_response = response #response.split("|")[0].strip()
        ja_response = response #response.split("|")[-1].strip()
        pretty_print("Kurisu", "Saying...", delay=0.05, overwrite=True)
        voice_over = kurisu_agent.say(tts_input)
        pattern = re.compile(r'```bash (flux_led.*?)```')
        match = pattern.search(response)
        if match:
            command = match.group(1)
            print(f"Executing command: {command}")
            result = subprocess.run(command.split(" "), capture_output=True, text=True)
            print(result.stdout)
        if voice_over is not None:
            sd.play(voice_over, samplerate=32000)
            pretty_print("Kurisu", en_response, delay=0.05, overwrite=True)
        
        


if __name__ == "__main__":
    try:
        record_and_detect()
    except KeyboardInterrupt:
        print("\nStopped.")