# CLAUDE.md

## Project Overview

`clients/apps/desktop/` in the KurisuAssistant monorepo — one member of the `clients/` npm workspace (see `../../CLAUDE.md`, and the root `CLAUDE.md`; the backend is in `../../../backend/`) — the Electron shell for the KurisuAssistant desktop client (Windows + Linux). The screens live in `@kurisu/ui` and everything under them in the other `@kurisu/*` packages; what is left here is the main process, a root that mounts `App`, the packaging config and the end-to-end suite. Chat interface with streaming responses, TTS, image attachments, conversation management, and animated 2D character video call window.

## Tech Stack

React 18, Electron 43, MUI v5, Framer Motion, Zustand, Axios, Vite, react-markdown, electron-updater, @modelcontextprotocol/sdk, TypeScript (strict mode)

**Electron is pinned to an exact version, not a range.** With the workspace hoisting `node_modules` to `clients/`, electron-builder cannot resolve `^43.6.0` and fails outright — one source of truth in `devDependencies` beats duplicating the number into `build.electronVersion`, where a bump could silently miss it.

**Electron must stay on a supported major.** Only the newest three get security fixes, and this app renders remote content in front of a privileged IPC surface — it sat on 28 for over two years (#90). Bumping it drags three other pins with it: `electron-builder`, `@playwright/test` **and** the Docker image tag that mirrors it, and the `node-version` in both desktop workflows (Electron's tooling needs Node ≥ 22.12).

## Commands

Dependencies install at the workspace root: `npm ci` from `clients/`, never from here. Everything below runs from this directory.

- Dev: `npm run electron:dev` (Vite on localhost:5173 + Electron)
- Build: `npm run electron:build` (tsc + Vite + electron-builder → `release/`)
- Unit tests: `npm test` (vitest, no build needed). `npm test` from `clients/` runs these plus the shared packages'.
- Typecheck: `npm run typecheck`
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

Workflows live at the repo root. `.github/workflows/desktop-build.yml` triggers on tags `desktop-vX.Y.Z`, sets `package.json` version from the tag, builds the NSIS installer on `windows-latest` and AppImage + deb on `ubuntu-latest`, and publishes them with `latest.yml` / `latest-linux.yml` as release `vX.Y.Z` on the legacy `Khoality-dev/KurisuAssistant-Client-Desktop` repo via `electron-builder --publish always` (`GH_TOKEN` = `CLIENT_RELEASE_TOKEN` secret, a PAT with write access to that repo). Keep `build.publish.repo` in `package.json` pointing there: installed apps' `electron-updater` reads that repo's latest release. `.github/workflows/desktop-test.yml` runs typecheck, vitest and the Playwright suite on pushes/PRs that touch `clients/apps/desktop/` or `clients/packages/`, and installs from `clients/` because that is where the lockfile is. Auto-update: `electron-updater` checks GitHub Releases on app startup, downloads updates in the background, and prompts the user to restart via `UpdateDialog`.

## The parts that bite

Eight things that are not obvious from the code and have each cost a debugging session:

- **The protocol is checked, not trusted, and it is no longer this app's.** `WIRE_PROTOCOL` and the event names live in `@kurisu/models` (`clients/packages/models/src/{constants,events}.ts`), still written by hand rather than generated — but `protocol.test.ts` there compares them against `protocol/events.json`, which the backend generates, so a mismatch fails `npm test` instead of shipping (#93). The union type is derived from the runtime array, so adding a name to one and not the other is a type error. A backend event change is still not done until that package and the docs move with it.
- **`allowed_paths` is a boundary, not a preference.** A host tool aimed outside it is refused, not prompted — see [docs/security.md](docs/security.md).
- **Client tests run against the mock, never a deployed backend** — unit, e2e, instrumented, screenshot capture. `tests/mock/server.ts` mirrors `backend/kurisuassistant/`; when they disagree the backend wins and the mock is fixed in the same PR as the protocol change. `npm run mock:backend` starts it on its own (#126).
- **The e2e suite cannot run on a headless host**, and it is the only one that catches WebSocket reconnect regressions. `npm run test:e2e:docker` needs nothing but Docker.
- **One WebSocket error code is not an error.** `NO_MODEL_SELECTED` means the account has never had a model chosen — every new account, since provisioning cannot pick one — so it renders as `NoModelPrompt` above the composer with a button onto Settings → Assistant, and the refused message goes back into the composer, instead of the red toast the other codes get ([docs/chat.md](docs/chat.md), #149). **Android mirrors this**, with one difference that matters for copy: there, Assistant is a top-level drawer entry, not a Settings row, so neither client should spell out the other's path.
- **The composer's scope resolves after login, and a draft must survive that.** `ChatComposer` is keyed on `personaId` and `conversationId`, both of which arrive asynchronously; it drops the draft only when *leaving* a concrete conversation, never on `null → id`. It used to clear on any change, which lost keystrokes and made Windows CI fail with a disabled Send right after `fill()` (#145, [docs/chat.md](docs/chat.md)). The e2e `send()` helpers deliberately stay naive.
- **The explorer has two roots, and one seam.** Kurisu Drive (#17) is a second root beside this machine, not a second app: everything the explorer reads goes through `@kurisu/api`'s `fileSource.ts`, which dispatches on a `drive://` prefix and passes local paths straight to the Electron bridge. Two traps live there. The **root listing is composed in the renderer**, because `electron/explorerIPC.ts` enumerates this machine's own drives and cannot know a server exists. And **separators**: a drive path is `/`-separated on every platform, so `fileSource` owns `joinPath`/`dirnameOf`/`basenameOf` and the four module-level `SEP` constants that used to do it are gone — on Windows every one of them was wrong for a drive path. Transfers are streamed by the **main process** (`electron/driveTransfers.ts`); the renderer never holds a gigabyte. Settings → Kurisu Drive is a view over `users.tool_policies`, not a second setting. **Android owes this too** — browsing, upload and download against the same endpoints — and until it lands, #17 is only half done.
- **Two different things are called "MCP" here.** The servers this client starts and calls ([docs/mcp.md](docs/mcp.md)), and the endpoint this app *is* for an external client ([docs/security.md](docs/security.md#the-built-in-mcp-server)).
