# CLAUDE.md

The speech service: **universal-voice**, the container `--profile voice` starts for recognition and synthesis. A FastAPI app (`universal_voice/`) that the backend's `routers/asr.py` and `routers/tts.py` proxy to over the Compose network (port 14213, never published, no authentication of its own — the API authenticates and this trusts the network). It was its own repository, universal-asr, until #202: Kurisu was its only consumer, a backend release tag could not pin it, and every change to the speech contract needed a PR in each repository.

This is the `voice/` package of the KurisuAssistant monorepo (see the root `CLAUDE.md`). Run the commands below from `voice/`. `docker compose` is **not** run here: the service is a member of `backend/docker-compose.yml`, built from `../voice`, so `cd ../backend && docker compose --profile voice up -d --build` is how it starts, and `backend/docs/tts.md` / `backend/docs/asr.md` describe how the API and the clients use it.

## Documentation Index

- [API](docs/api.md) — every route, its request and response, and which backend proxy calls it.
- [Models](docs/models.md) — the ASR model cache (pull, convert, list, delete) and the TTS registry with its backends.

## Layout

```
universal_voice/
  main.py              the app; the lifespan pre-loads the default ASR model and the in-process TTS engine
  config.py            every setting, read from the environment once at import
  routers/
    transcription.py   /asr, /asr/detect-language (raw PCM), /v1/audio/* (OpenAI-shaped uploads)
    tts.py             /tts/synthesize, /tts/voices
    health.py          /health, /v1/models (+ pull, delete)
  models/
    manager.py         resolve a model name to a local CTranslate2 directory: cached, pulled, or converted
    transcriber.py     loaded WhisperModel instances, transcription, language detection
  tts/
    base.py            BaseTTSModel: synthesize / list_voices / check_health / is_loaded
    registry.py        the model ids the clients see, lazily built
    text_processing.py split_text (200 chars, paragraphs then sentences) and merge_wav_files
    *_model.py         one file per backend
  static/index.html    a debugging page: transcribe, detect language, manage models
tests/                 fakes for the registry and the transcriber; nothing loads a model
```

## Key facts

- **Configuration is environment only** — `config.py`, `UVOICE_*`. The ASR settings are still read under their old `UASR_*` names as a fallback, because environment files from before the service fronted synthesis set those. The Compose file in `backend/` is what sets them in a deployment; `docs/models.md` lists them.
- **Heavy imports are lazy** — torch (`config.py`), faster-whisper (`models/transcriber.py`), the synthesis SDKs (`tts/*_model.py`) are imported inside the function that first needs them. That is what lets the routers import on a bare runner, and `requirements-ci.txt` is the list of what the tests need; a new module-level heavy import fails CI at collection.
- **The wire contract with the backend** is `POST /asr` (Int16 PCM, 16 kHz, mono, as `application/octet-stream`; `?language`, `?model`, `?initial_prompt`), `POST /asr/detect-language`, `GET /v1/models`, `POST /tts/synthesize` (multipart: `text`, `model`, `voice_id`, `language`, `ref_audio`, `ref_text`), `GET /tts/voices`, `GET /health`. `backend/tests/test_tts_router.py` and this package's `tests/test_routers.py` pin the two ends; change both in the same PR.
- **Every synthesis backend goes through `split_text`** at 200 characters and `merge_wav_files`; a backend never sees a whole paragraph.
- **Model cache** — `UVOICE_DATA_DIR/models/<safe name>`, a Docker volume in the stack (`uvoice-data`). Re-downloadable; not part of a backup.

## Tests

```bash
pip install -r requirements-ci.txt
python -m pytest tests -q
```

CI: `.github/workflows/voice-test.yml`, scoped to `voice/**`. The tests drive the routes against fakes; anything that needs a GPU is run by hand against the container.
