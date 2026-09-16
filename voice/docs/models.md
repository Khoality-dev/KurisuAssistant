# Models

## ASR: the cache

`models/manager.py` resolves a model name to a directory under `UVOICE_DATA_DIR/models/`, named after the model with anything outside `[\w\-.]` replaced by `_` (`vinai/PhoWhisper-base` → `vinai_PhoWhisper-base`). A directory holding a `model.bin` is a cached model.

- A standard Whisper size (`tiny` … `large-v3`, `distil-*`, `turbo`) is downloaded through faster-whisper's own `download_model`, already in CTranslate2 form.
- Anything else is taken as a Hugging Face id: `WhisperForConditionalGeneration` and `WhisperProcessor` are downloaded, converted with `ctranslate2.converters.TransformersConverter` at the configured `COMPUTE_TYPE`, and the processor files saved beside the converted weights so `list_models` can show the original name.

Downloads are serialised by one lock. `GET /v1/models/pull` is the only way to add a model from outside; the default model is resolved at startup.

`models/transcriber.py` keeps one `WhisperModel` per name, loaded on first use with `DEVICE`/`COMPUTE_TYPE`, and transcribes with `without_timestamps=True` (faster; timestamps were never used). Language detection looks at the first 30 seconds and can be constrained to a list of codes — the routing mode in the clients (`backend/docs/asr.md`).

### Settings

| Variable | Default | Read as |
| --- | --- | --- |
| `UVOICE_HOST`, `UVOICE_PORT` | `0.0.0.0`, `14213` | bind address |
| `UVOICE_DEVICE` | `auto` | `cuda` when torch sees one, else `cpu` |
| `UVOICE_COMPUTE_TYPE` | `auto` | `float16` on cuda, `int8` on cpu |
| `UVOICE_DEFAULT_MODEL` | `base` | the ASR model pre-loaded at startup and used when a request names none |
| `UVOICE_DATA_DIR` | `voice/data` | the cache root; `/app/data` in the container, the `uvoice-data` volume |
| `HF_TOKEN` | — | for gated Hugging Face models |

Each of the ASR settings is also read under its older `UASR_*` name.

## TTS: the registry

`tts/registry.py` builds the model list on first access. Each entry is a `BaseTTSModel` (`tts/base.py`): `synthesize(text, voice_id, language, ref_audio_bytes, ref_text, **kwargs) -> wav bytes`, `list_voices()`, `check_health()`, `is_loaded()`. The ids are what the clients store in their settings; do not rename one without a migration on both clients.

| Id | Where it runs | Reference audio | Notes |
| --- | --- | --- | --- |
| `vieneu:<mode>` | in this process, the `vieneu` SDK (`tts/vieneu_model.py`) | encoded to `ref_codes`, cached by content hash | Vietnamese. `mode` is `UVOICE_TTS_MODE` (`turbo` by default); pre-loaded at startup. Presets via `list_voices`. |
| `gpt-sovits` | the `gpt-sovits` container (`tts/gpt_sovits_model.py`) | written to `UVOICE_GPTSOVITS_REF_AUDIO_DIR`, a volume both containers mount, and passed as a path | Requires a reference. `text_lang`/`prompt_lang` default to `ja`. `--profile sovits`. |
| `vixtts` | the `vixtts` container (`tts/vixtts_model.py`) | uploaded as multipart `spk_audio` | XTTS-v2 fine-tune; `language` passed through. The stack's default (`UVOICE_TTS_DEFAULT_MODEL=vixtts`). |

Every backend goes through `text_processing.split_text` (200 characters; paragraphs first, then sentence punctuation including `。！？`) and `merge_wav_files`, so long text is many short syntheses.

### Settings

| Variable | Default |
| --- | --- |
| `UVOICE_TTS_DEFAULT_MODEL` | `vixtts` |
| `UVOICE_TTS_MODE` | `turbo` — the VieNeu engine mode, part of its model id |
| `UVOICE_GPTSOVITS_URL` | `http://gpt-sovits-container:9880` |
| `UVOICE_VIXTTS_URL` | `http://vixtts-container:19770` |
| `UVOICE_GPTSOVITS_REF_AUDIO_DIR`, `UVOICE_GPTSOVITS_REF_AUDIO_PREFIX` | `/shared-ref-audio` — where this process writes a reference clip, and the path the GPT-SoVITS container sees it at |
