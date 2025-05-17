from transformers import pipeline
import torch


class ASR:
    def __init__(self, model_name = "whisper-finetuned"):
        self.model_name = model_name
        self.asr = pipeline(
            model=self.model_name,
            task='automatic-speech-recognition',
            device='cuda' if torch.cuda.is_available() else 'cpu',
        )

    def __call__(self, waveform):
        final = self.asr(waveform)
        text = final["text"]
        return text