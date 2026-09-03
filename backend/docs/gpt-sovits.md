# GPT-SoVITS Service

GPT-SoVITS is the voice synthesis engine used by KurisuAssistant for text-to-speech. It runs as a separate Docker container with GPU access.

## Docker Configuration

```yaml
gpt-sovits:
  image: legwork7623/gpt-sovits:latest
  container_name: gpt-sovits-container
  ports:
    - "9880:9880"
  shm_size: 16G
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: all
            capabilities: [gpu]
```

**Requirements**: NVIDIA GPU with Docker GPU support (nvidia-container-toolkit).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `is_half` | `False` | Use FP16 inference (set `True` for GPUs with good FP16 support) |
| `is_share` | `False` | Enable Gradio public sharing |

## Data Volumes

| Host Path | Container Path | Description |
|-----------|----------------|-------------|
| `./data/sovits/output` | `/workspace/output` | Generated output files |
| `./data/sovits/logs` | `/workspace/logs` | Training and inference logs |
| `./data/sovits/weights` | `/workspace/SoVITS_weights` | Model weights |
| `./data/voice_storage` | `/workspace/data/voice_storage` | Reference audio files for voice cloning |

## Voice References

Place reference audio files in `data/voice_storage/`. Supported formats: `.wav`, `.mp3`, `.flac`, `.ogg`.

These files are used for zero-shot voice cloning — the model mimics the voice from the reference audio when synthesizing speech.

Files added here automatically appear in the `/tts/voices` API endpoint and can be selected per-agent in the frontend.

## API

The GPT-SoVITS server exposes port `9880`. The main endpoint:

```
GET http://<host>:9880/tts?text=...&ref_audio_path=...&text_lang=ja&prompt_lang=ja
```

**Key parameters**:

| Parameter | Description |
|-----------|-------------|
| `text` | Text to synthesize |
| `ref_audio_path` | Path to reference audio (relative to container working dir) |
| `text_lang` | Language of the input text (e.g., `ja`, `en`, `zh`) |
| `prompt_lang` | Language of the reference audio |
| `text_split_method` | Text splitting strategy (default: `cut5`) |
| `batch_size` | Inference batch size (default: `20`) |
| `media_type` | Output format (default: `wav`) |

**Response**: Audio data in the requested format.

## Integration with KurisuAssistant

The API service communicates with GPT-SoVITS through the `GPTSoVITSProvider` in `tts/gpt_sovits_provider.py`:

1. Finds the reference audio file in `data/voice_storage/`
2. Splits long text into chunks (max 200 chars) to prevent OOM
3. Sends each chunk as a GET request with the reference audio path
4. Merges resulting WAV chunks into a single file

The TTS server URL can be configured:
- **Default**: `TTS_API_URL` environment variable (fallback: `http://10.0.0.122:9880/tts`)
- **Per-user**: Via the "TTS Server URL" field in client Settings > TTS tab
- **Per-request**: Via the `api_url` parameter in `POST /tts`

## Troubleshooting

**Container won't start**: Ensure nvidia-container-toolkit is installed and `docker run --gpus all nvidia/cuda:12.0-base nvidia-smi` works.

**OOM errors**: Reduce `batch_size` or `max_chunk_length`. Set `is_half=True` if your GPU supports it.

**No audio output**: Check that the reference audio file exists in `data/voice_storage/` and is a valid audio file. Check container logs with `docker logs gpt-sovits-container`.

**Connection refused**: Verify the container is running (`docker ps`) and port 9880 is accessible. Use the "Connect" button in Settings > TTS to test connectivity.
