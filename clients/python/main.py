import wave
import torch
import sounddevice as sd
import numpy as np
import time
from pathlib import Path
from clients.python.helpers.utils import pretty_print
from clients.python.helpers.agent import Agent
from threading import Condition, Thread

print("Initializing...")
vad_model, utils = torch.hub.load(
    repo_or_dir="snakers4/silero-vad", model="silero_vad", force_reload=False
)
(get_speech_timestamps, save_audio, read_audio, VADIterator, collect_chunks) = utils
vad_iterator = VADIterator(vad_model)

# Settings
sample_rate = 16000  # Whisper and VAD both use 16 kHz
block_duration = 0.03  # 30 ms (must be 10, 20, or 30 ms)
block_size = int(sample_rate * block_duration)  # Samples per block
input_device, output_device = sd.default.device
devices = sd.query_devices()
VAD_FIXED_WINDOW_SIZE = 512  # e.g., 1024-sample window (~64ms)
RECORD_WINDOW_SIZE = (16000) * 2  # e.g., 16000-sample window (1 second) * 2
min_speech_silence_s = 1  # 1s of silence to end utterance
min_speech_silence_after_interaction_s = 10
text_output_queue = []
text_output_condition = Condition()
input_message = None
audio_output_queue = []
audio_output_condition = Condition()


feedback_volume = 0.5
assets_dir = Path(__file__).parent / "assets"
start_feedback_effect = wave.open(assets_dir / "start_effect.wav")
start_feedback_effect = (
    np.frombuffer(start_feedback_effect.readframes(-1), dtype=np.int16).reshape((-1, 2))
    * feedback_volume
).astype(np.int16)
stop_feedback_effect = wave.open(assets_dir / "stop_effect.wav")
stop_feedback_effect = (
    np.frombuffer(stop_feedback_effect.readframes(-1), dtype=np.int16).reshape((-1, 2))
    * feedback_volume
).astype(np.int16)
last_voice_time = time.time()
last_interaction_time = 0
is_interacting = False
kurisu_agent = Agent()

print("Current input device:")
print(f"  Index: {input_device}")
print(f"  Name: {devices[input_device]['name']}")
print()
print("Current output device:")
print(f"  Index: {output_device}")
print(f"  Name: {devices[output_device]['name']}")

audio_buffer = np.array([], dtype=np.float32)


def record_and_detect():
    """Continuously listen and collect speech when VAD detects voice."""
    speaking = False
    global last_voice_time, last_interaction_time, is_interacting
    with sd.InputStream(
        channels=1, samplerate=sample_rate, blocksize=block_size, dtype="float32"
    ) as stream:
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
                    if "start" in speech:
                        speaking = True

                        if last_voice_time == -1:
                            if time.time() - last_interaction_time > min_speech_silence_after_interaction_s:
                                is_interacting = False
                                min_speech_silence_s = 1
                            if is_interacting:
                                sd.play(start_feedback_effect.flatten())

                    if "end" in speech:
                        last_voice_time = time.time()
                        speaking = False

            if (
                not speaking
                and last_voice_time != -1
                and (time.time() - last_voice_time) > min_speech_silence_s
            ):
                segment = recording.copy()
                recording = np.zeros((0, 1), dtype=np.float32)
                if is_interacting:
                    sd.play(stop_feedback_effect.flatten(), blocking=True)
                    last_interaction_time = time.time()
                transcribe_audio(segment)
                last_voice_time = -1

            if not speaking and last_voice_time == -1:
                if len(recording) > RECORD_WINDOW_SIZE:
                    recording = recording[-RECORD_WINDOW_SIZE:]


def logging(data):
    """Add log data to the agent conversation."""
    with text_output_condition:
        text_output_queue.append(data)
        text_output_condition.notify()


def transcribe_audio(audio):
    """Transcribe the captured audio"""
    if len(audio) == 0:
        return
    ## debug: playback the recording
    # audio = nr.reduce_noise(y=audio, sr=sample_rate)
    # play the audio to the speaker
    # sd.play((audio.flatten() * 32768).astype(np.int16), samplerate=sample_rate)
    # sd.wait()
    global last_interaction_time, is_interacting, min_speech_silence_s
    transcript = kurisu_agent.transcribe((audio.flatten() * 32768).astype(np.int16))
    if transcript is None or ('kurisu' not in transcript.lower() and not is_interacting):
        return
    
    if not is_interacting:
        sd.play(start_feedback_effect.flatten(), blocking=True)
        is_interacting = True
        min_speech_silence_s = 2
    logging({"message": transcript, "delay": 0.05})
    i = 0
    #\033[32mUser:\033[0m print in red
    logging({"message": "\033[31mKurisu:\033[0m Thinking...", "delay": 0.05, "end": "\n"})

    full_response = ""
    i = 0
    for message, voice_data in kurisu_agent.process_and_say(message=transcript):
        if i == 0:
            logging({"message": "\033[31mKurisu: \033[0m ", "end": "", "overwrite": True})
        
        logging({"message": message, "delay": 0.05, "end": ""})
        full_response += message
        if voice_data is not None:
            with audio_output_condition:
                audio_output_queue.append(voice_data)
                audio_output_condition.notify()
        i += 1
        
    logging({})
    # print in green color 
    logging({"message":"\033[32mUser:\033[0m ", "end": ""})
    last_interaction_time = time.time()
    


def output_text_consumer():
    """Consume text output from the agent and play it to the speaker."""
    # make a conditional variable to check if the queue is empty
    while True:
        with text_output_condition:
            while len(text_output_queue) == 0:
                text_output_condition.wait()
            params = text_output_queue.pop(0)
            pretty_print(**params)


def output_audio_consumer():
    """Consume audio output from the agent and play it to the speaker."""
    # make a conditional variable to check if the queue is empty
    while True:
        with audio_output_condition:
            while len(audio_output_queue) == 0:
                audio_output_condition.wait()
            audio_output = audio_output_queue.pop(0)

            audio_output = audio_output[50:] # mask out the first 50 samples as it causes a pop sound
            sd.play(audio_output, samplerate=32000)
            sd.wait()



if __name__ == "__main__":
    try:
        output_text_consumer_thread = Thread(target=output_text_consumer)
        output_text_consumer_thread.daemon = True
        output_text_consumer_thread.start()
        output_audio_consumer_thread = Thread(target=output_audio_consumer)
        output_audio_consumer_thread.daemon = True
        output_audio_consumer_thread.start()
        logging({"message": "\033[32mUser:\033[0m ", "end": ""})
        record_and_detect()
    except KeyboardInterrupt:
        print("\nStopped.")
