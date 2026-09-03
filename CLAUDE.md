# CLAUDE.md

Monorepo for KurisuAssistant. Three independent packages with no shared build tooling:

- `backend/` — Python FastAPI service, WebSocket protocol, Docker Compose stack. Read `backend/CLAUDE.md` before touching it.
- `clients/desktop/` — Electron + React + TypeScript client. Read `clients/desktop/CLAUDE.md`.
- `clients/android/` — Kotlin + Jetpack Compose client. Read `clients/android/CLAUDE.md`.

Each package keeps its own toolchain, `.gitignore`, tests, and commands. Run them from inside the package directory; the backend in particular uses cwd-relative `data/` paths and `docker compose` must be run from `backend/`.

## Cross-cutting rules

- **Protocol contract** lives in the backend: `backend/docs/websocket.md` and `backend/docs/API.md`. Event names are hand-typed string literals in both clients (desktop: `src/api/`, Android: `data/remote/websocket/`). A backend event change is not done until both clients and the docs are updated in the same commit.
- **Client parity** (QR login payload, storage keys, slash commands, settings) is documented in each client's `CLAUDE.md`. When one client gains a feature the other is expected to mirror, note it in both files.
- **CI** lives in `.github/workflows/` at the root. `desktop-test.yml` runs on changes under `clients/desktop/`. `desktop-build.yml` and `android-release.yml` are release workflows triggered by `desktop-v*` / `android-v*` tags; they publish to the legacy per-client repositories because both apps' in-app updaters read `releases/latest` from those repositories. Do not change `build.publish` in `clients/desktop/package.json` or the URL in the Android `UpdateRepository` without also migrating the update channel.
- **Backend has no CI.** Run `pytest` from `backend/` (integration tests are marked `integration` and need Postgres/Ollama).
