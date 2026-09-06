# GPT-SoVITS Service

GPT-SoVITS is the second voice synthesis backend. viXTTS is the default; this
one is opt-in, behind a profile, and reached only through universal-voice.

```bash
VIXTTS_ROOT=... UVOICE_ROOT=... \
  docker compose --profile voice --profile sovits up -d
```

## Docker Configuration

As it actually stands in `docker-compose.yml`:

```yaml
gpt-sovits:
  profiles: ["sovits"]
  image: legwork7623/gpt-sovits:latest
  container_name: gpt-sovits-container
  expose:
    - "9880"
  volumes:
    - ./data/sovits/output:/workspace/output
    - ./data/sovits/logs:/workspace/logs
    - ./data/sovits/weights:/workspace/SoVITS_weights
    - ./data/voice_storage:/workspace/data/voice_storage
    - tts-ref-audio:/shared-ref-audio
  shm_size: 16G
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: all
            capabilities: [gpu]
```

**It is not published to the host** — `expose` puts it on the Compose network
only. Reach it from inside: `docker compose exec universal-voice curl
http://gpt-sovits-container:9880/...`. The four `./data` bind mounts do not
exist in a fresh checkout, and Docker will create them owned by root; make them
yourself first (`mkdir -p data/voice_storage data/sovits/{output,logs,weights}`).

**Requirements**: NVIDIA GPU with Docker GPU support (nvidia-container-toolkit).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `is_half` | `True` | FP16 inference. The Compose file sets `True`; the container's own default is `False` |
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

The API does not call this service directly and there is no `TTS_API_URL`
variable — nothing reads that name. The chain is: the API calls universal-voice
at `UVOICE_URL`, and universal-voice calls this service at
`UVOICE_GPTSOVITS_URL` (`http://gpt-sovits-container:9880`), both set in
`docker-compose.yml`.

## Troubleshooting

**Container won't start**: Ensure nvidia-container-toolkit is installed and `docker run --gpus all nvidia/cuda:12.0-base nvidia-smi` works.

**OOM errors**: Reduce `batch_size` or `max_chunk_length`. Set `is_half=True` if your GPU supports it.

**No audio output**: Check that the reference audio file exists in `data/voice_storage/` and is a valid audio file. Check container logs with `docker logs gpt-sovits-container`.

**Connection refused**: verify the container is running (`docker compose ps`)
and that you are calling it from inside the Compose network — 9880 is not
published to the host, so `curl localhost:9880` from the host will always be
refused.
