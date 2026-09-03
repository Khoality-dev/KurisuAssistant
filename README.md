# Kurisu Assistant

A voice-based AI assistant: speech recognition, voice synthesis, and LLM-driven agents with tools and memory, served by a backend and used from a desktop app and an Android app. This repository holds all three.

## Layout

| Path | What it is | Stack |
|------|------------|-------|
| [`backend/`](backend/) | API server, WebSocket protocol, agents, TTS/ASR integration, Docker Compose stack | Python, FastAPI, PostgreSQL + pgvector, Docker |
| [`clients/desktop/`](clients/desktop/) | Desktop client for Windows and Linux | React 18, Electron 28, TypeScript, Vite |
| [`clients/android/`](clients/android/) | Android client | Kotlin, Jetpack Compose, Hilt |

The three packages share no build tooling. Each one has its own README, `CLAUDE.md`, `.gitignore`, tests, and commands, and they are run from inside their own directory.

## Quick start

Backend (Docker):

```bash
cd backend
cp .env_template .env        # edit with your settings
docker compose up -d
```

Default account: `admin` / `admin`. See [backend/README.md](backend/README.md) for local development and configuration.

Desktop client:

```bash
cd clients/desktop
npm install
npm run electron:dev
```

Android client:

```bash
cd clients/android
./gradlew assembleDevDebug     # needs JAVA_HOME pointing at a JDK 17
```

## Protocol

The clients talk to the backend over REST and a WebSocket. The contract is documented in [backend/docs/API.md](backend/docs/API.md) and [backend/docs/websocket.md](backend/docs/websocket.md). Event names are hand-written string literals on both clients, so a change to a server event is only complete once both clients and the docs are updated in the same commit.

## Releases

Both apps check for updates against GitHub Releases on their original repositories, so those repositories remain the release channels. The code lives here; the release artifacts are published there.

| Client | Trigger | Workflow | Publishes to |
|--------|---------|----------|--------------|
| Desktop | push tag `desktop-vX.Y.Z` | [`desktop-build.yml`](.github/workflows/desktop-build.yml) | release `vX.Y.Z` on `Khoality-dev/KurisuAssistant-Client-Desktop` |
| Android | push tag `android-vX.Y.Z` (must equal `versionName` in `clients/android/app/build.gradle.kts`) | [`android-release.yml`](.github/workflows/android-release.yml) | release `vX.Y.Z` on `Khoality-dev/KurisuAssistant-Client-Android` |

Both workflows need a `CLIENT_RELEASE_TOKEN` repository secret: a personal access token with Contents read/write on the two client repositories. The Android workflow also needs the keystore secrets listed at the top of its file. Desktop end-to-end tests run on every push that touches `clients/desktop/` ([`desktop-test.yml`](.github/workflows/desktop-test.yml)).

The backend has no release artifacts. It is deployed from source with Docker Compose.

## History

This repository was assembled on 2026-09-02 from three repositories: the backend (this repository's original history, now under `backend/`), `KurisuAssistant-Client-Desktop` (now `clients/desktop/`), and `KurisuAssistant-Client-Android` (now `clients/android/`). Each client's history was rewritten into its subdirectory before merging, so `git log --follow` and `git blame` work across the move.

## License

MIT. See [LICENSE](LICENSE).
