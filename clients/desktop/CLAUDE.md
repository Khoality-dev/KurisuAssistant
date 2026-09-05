# CLAUDE.md

## Project Overview

`clients/desktop/` in the KurisuAssistant monorepo (see the root `CLAUDE.md`; the backend is in `../../backend/`) — cross-platform desktop client (Windows + Linux) for the KurisuAssistant AI platform. React + Electron + TypeScript + MUI + Framer Motion. Chat interface with streaming responses, TTS, image attachments, conversation management, and animated 2D character video call window.

## Tech Stack

React 18, Electron 28, MUI v5, Framer Motion, Zustand, Axios, Vite, react-markdown, electron-updater, @modelcontextprotocol/sdk, TypeScript (strict mode)

## Commands

- Dev: `npm run electron:dev` (Vite on localhost:5173 + Electron)
- Build: `npm run electron:build` (tsc + Vite + electron-builder → `release/`)
- Unit tests: `npm test` (vitest, no build needed)
- E2E tests: `npm run test:e2e:build` then `npm run test:e2e` — and `npm run test:e2e:docker` on a machine with no display. See [docs/testing.md](docs/testing.md).

## Documentation Index

- [Architecture](docs/architecture.md) — the file-by-file map, and the code style it follows
- [Chat runtime](docs/chat.md) — streaming, TTS, interactive voice mode, conversations, slash commands, shortcuts
- [Authentication and storage](docs/auth.md) — login and refresh, QR login, where tokens live, localStorage keys
- [Security model](docs/security.md) — host-tool boundary, MCP spawn consent, the built-in MCP server, certificates
- [MCP servers](docs/mcp.md) — the servers this client starts and calls
- [Character animation](docs/character.md) — pose graph, canvas compositing, the graph editor
- [Testing](docs/testing.md) — unit and e2e suites, and the Docker route for headless machines
- [Backend endpoints](docs/endpoints.md) — the REST and WebSocket surface this client calls
- [Screens](docs/screens.md) — screenshots and how they are captured

**These documents are part of the code.** A change that makes one of them wrong is not finished: update it in the same commit. The failures that motivated the rule are on record — #138, a map pointing at a screen nothing rendered, and #91, a security section describing a filed vulnerability as a design decision.

## CI/CD

Workflows live at the repo root. `.github/workflows/desktop-build.yml` triggers on tags `desktop-vX.Y.Z`, sets `package.json` version from the tag, builds the NSIS installer on `windows-latest` and AppImage + deb on `ubuntu-latest`, and publishes them with `latest.yml` / `latest-linux.yml` as release `vX.Y.Z` on the legacy `Khoality-dev/KurisuAssistant-Client-Desktop` repo via `electron-builder --publish always` (`GH_TOKEN` = `CLIENT_RELEASE_TOKEN` secret, a PAT with write access to that repo). Keep `build.publish.repo` in `package.json` pointing there: installed apps' `electron-updater` reads that repo's latest release. `.github/workflows/desktop-test.yml` runs typecheck, vitest and the Playwright suite on pushes/PRs that touch `clients/desktop/`. Auto-update: `electron-updater` checks GitHub Releases on app startup, downloads updates in the background, and prompts the user to restart via `UpdateDialog`.

## The parts that bite

Four things that are not obvious from the code and have each cost a debugging session:

- **The protocol is retyped by hand.** `src/constants.ts` holds `WIRE_PROTOCOL`; the event names are string literals in `src/api/websocket.ts`, matching a Python enum in the backend and Kotlin literals in Android. Nothing checks that the three agree (#93). A backend event change is not done until this client and the docs move with it.
- **`allowed_paths` is a boundary, not a preference.** A host tool aimed outside it is refused, not prompted — see [docs/security.md](docs/security.md).
- **The e2e suite cannot run on a headless host**, and it is the only one that catches WebSocket reconnect regressions. `npm run test:e2e:docker` needs nothing but Docker.
- **Two different things are called "MCP" here.** The servers this client starts and calls ([docs/mcp.md](docs/mcp.md)), and the endpoint this app *is* for an external client ([docs/security.md](docs/security.md#the-built-in-mcp-server)).
