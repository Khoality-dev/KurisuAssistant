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
- Mock backend, standalone: `npm run mock:backend -- --port 15597 [--host 0.0.0.0] [--scenario <name>]` (`--list` names the scenarios). The same mock the e2e fixtures start per test, kept running for manual testing and for the Android instrumented suite (#126). See [docs/testing.md](docs/testing.md#the-standalone-mock).

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

Six things that are not obvious from the code and have each cost a debugging session:

- **The protocol is checked, not trusted.** `src/constants.ts` holds `WIRE_PROTOCOL` and `src/api/websocket.ts` holds the event names, both still written here rather than generated — but `src/api/protocol.test.ts` compares them against `protocol/events.json`, which the backend generates, so a mismatch fails `npm test` instead of shipping (#93). The union type is derived from the runtime array, so adding a name to one and not the other is a type error. A backend event change is still not done until this client and the docs move with it.
- **`allowed_paths` is a boundary, not a preference.** A host tool aimed outside it is refused, not prompted — see [docs/security.md](docs/security.md).
- **Client tests run against the mock, never a deployed backend** — unit, e2e, instrumented, screenshot capture. `tests/mock/server.ts` mirrors `backend/kurisuassistant/`; when they disagree the backend wins and the mock is fixed in the same PR as the protocol change. `npm run mock:backend` starts it on its own (#126).
- **The e2e suite cannot run on a headless host**, and it is the only one that catches WebSocket reconnect regressions. `npm run test:e2e:docker` needs nothing but Docker.
- **One WebSocket error code is not an error.** `NO_MODEL_SELECTED` means the account has never had a model chosen — every new account, since provisioning cannot pick one — so it renders as `NoModelPrompt` above the composer with a button onto Settings → Assistant, and the refused message goes back into the composer, instead of the red toast the other codes get ([docs/chat.md](docs/chat.md), #149). **Android mirrors this**, with one difference that matters for copy: there, Assistant is a top-level drawer entry, not a Settings row, so neither client should spell out the other's path.
- **The composer's scope resolves after login, and a draft must survive that.** `ChatComposer` is keyed on `personaId` and `conversationId`, both of which arrive asynchronously; it drops the draft only when *leaving* a concrete conversation, never on `null → id`. It used to clear on any change, which lost keystrokes and made Windows CI fail with a disabled Send right after `fill()` (#145, [docs/chat.md](docs/chat.md)). The e2e `send()` helpers deliberately stay naive.
- **Two different things are called "MCP" here.** The servers this client starts and calls ([docs/mcp.md](docs/mcp.md)), and the endpoint this app *is* for an external client ([docs/security.md](docs/security.md#the-built-in-mcp-server)).
