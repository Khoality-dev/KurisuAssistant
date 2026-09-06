# Testing

[← clients/desktop](../CLAUDE.md)

What runs where, and the one suite that cannot run on the host.

E2E tests live in `tests/` and run via Playwright's Electron support.

- `playwright.config.ts` — serial, single worker (each test spawns its own Electron + mock backend).
- `tests/fixtures.ts` — `test` fixture that launches Electron pointing at `dist-electron/main.js` with an isolated userData dir (via `KURISU_E2E_USER_DATA_DIR` env var, which `electron/main.ts` honors for tests only), starts a mock backend on a random port, and seeds `kurisu_backend_url` in localStorage before reload. The `appPaths` fixture owns that temp dir, the path of the main process's `settings.json` inside it, and a free port passed as `KURISU_E2E_MCP_PORT` — the built-in MCP server must not be tested on its default port, or the suite would be driving whatever install is already running on the machine.
- `tests/mock/server.ts` — HTTP + WebSocket mock. Endpoints: `/version`, `/login`, `/register`, `/auth/refresh`, `/users/me` (+ tool-policies), `GET|PATCH /assistant`, `GET|POST /personas` and `GET|PATCH|DELETE /personas/{id}` (+ `/enabled`), `GET|POST /sub-agents` and `GET|PATCH|DELETE /sub-agents/{id}` (+ `/enabled`), `GET /conversations` (honours `?persona_id=`, and answers it with the same stingy one-element shape the backend does), `GET|PATCH|DELETE /conversations/{id}`, `/models`, `/tools`, `/mcp-servers`, `/skills`, `/faces`, `/tts/*`, plus `/ws/chat`. There is no `/agents`: it falls through to the catch-all `{}`.
  Over the socket it emits `connected` (with `persona_id`), `stream_chunk`, `done`, and — on a `compact_context` event — `context_info` twice, compacting the conversation in place the way the server does (#99). It enforces the wire protocol in the handshake, closing with 4426 on a mismatch.
  Configurable via `setStream`, `setTools`, `setAssistantModel` (pass `null` for a fresh account that has never had one chosen), `addPersona`, `addSubAgent`, `addMcpServer`, `setWireProtocol(n)` (what `/version` reports, what every other request's `X-Wire-Protocol` is checked against for a 426 with the backend's body shape, and what the socket handshake closes 4426 against) and `setUnreachable('/tts/models' | '/models')` (answer 502 as the backend does when the service behind the endpoint is down). `dropAllWebSockets()` simulates a silent backend socket loss. Tracks `lastChatRequest`, `lastConversationPatch` and `lastMcpServerCreate` for assertions; `getConversation`/`getConversations`/`getPersonas`/`getAssistant` read its state back.
  A scripted `StreamChunk` speaks as the conversation's bound persona unless it sets `personaId`/`personaName` — which is how a handoff is scripted, since the client splits assistant bubbles on `persona_id`. A `role: 'tool'` chunk carries `name`, `toolKind` and `durationMs` instead, and goes out with `persona_id`/`persona_name` null.
- Specs (Playwright, `*.spec.ts`): `smoke.spec.ts`, `streaming.spec.ts`, `settings.spec.ts`, `mcp.spec.ts`, `resilience.spec.ts`, `regression.spec.ts`, `mcpServer.spec.ts`, `credentials.spec.ts`, `firstRun.spec.ts`, `updateRequired.spec.ts`, `unreachableServices.spec.ts`.
  - `updateRequired.spec.ts` sets the mock's wire protocol away from the client's before boot and asserts the gate says which side to update and that "Change server" lands on the login form; then logs in on a matching protocol, moves the mock's, and asserts the next 426 raises the same screen (#150).
  - `unreachableServices.spec.ts` makes `/tts/models` and `/models` answer 502 and asserts the settings screens show the server's reason instead of an invented or empty list (#151).
  - Every spec's `send()` helper fills the composer and clicks Send straight away, on purpose: that is the race in #145 (the composer used to wipe a draft when its persona or conversation resolved after login, which on a slow runner happened after the fill). The fix is in `ChatComposer`, pinned by `src/components/chat/ChatComposer.test.tsx`; the helpers stay naive so the e2e keeps exercising it.
  - `firstRun.spec.ts` puts the mock in the state a brand-new account is in — `mock.setAssistantModel(null)` — and asserts the first message gets the `NoModelPrompt` and its way onto the Assistant screen rather than the red toast, that the refused text comes back to the composer, and that choosing a model lets the same message through (#149).
  - `mcpServer.spec.ts` drives the built-in MCP server over HTTP — token minted, anonymous refused, browser refused, SSE stream opens, nothing reachable off loopback. It talks to the app other than through the UI, and it earned that: the header heuristic in `mcpServerAuth.ts` passed every unit test while refusing every real client, because Node's `fetch` sends `sec-fetch-mode`.
  - `credentials.spec.ts` logs in and checks that no token reaches localStorage, then forks on `credentials.isSecure()`: with a keychain the session survives a reload and the stored file holds no readable token; without one (a CI container has no secret service) nothing is written and the reload lands back on the login form.
- Unit tests (vitest, `*.test.ts`) run with no Electron build: `tests/mock/server.test.ts` pins the mock's own shapes against the backend contract, `tests/mock/cli.test.ts` pins the standalone entry's argument parsing and starts every scenario once, `tests/appTools.test.ts` fails the build if an app tool is advertised without a handler, `tests/hostToolPolicy.test.ts` / `tests/mcpConsent.test.ts` / `tests/mcpServerAuth.test.ts` cover the three security decisions the main process makes — which paths a host tool may touch, which programs may be spawned, who may reach the built-in MCP server — `src/utils/storage.test.ts` pins the negative property that no token is ever written to localStorage, `src/store/conversationStore.test.ts` and `src/utils/commands.test.ts` cover the conversation store and the slash-command parser, `src/components/chat/ChatComposer.test.tsx` renders the composer (react-dom + `act`, no testing-library) and pins that a draft survives its scope resolving and is dropped when leaving a conversation, and `src/utils/wireProtocol.test.ts` pins the update screen's copy. `vitest.config.ts` includes `tests/**/*.test.ts` alongside `src/**`; the `.spec.ts` / `.test.ts` split is what keeps the two runners apart.
## The standalone mock

`npm run mock:backend -- --port 15597 [--host 0.0.0.0] [--scenario <name>]` starts the same
`MockBackend` on its own and keeps it running until Ctrl-C (#126). `tests/mock/cli.ts` is the
entry; `package.json` bundles it with esbuild into the gitignored `dist-mock/` first, so a checkout
needs `npm ci` and nothing else. Any username and password sign in. `--host 0.0.0.0` is for an
Android emulator, which reaches the host at `http://10.0.2.2:<port>`, or for a phone on the LAN.
`MOCK_DEBUG=1` logs every socket event.

Scenarios (`tests/mock/scenarios.ts`, `--list` prints them) are the states the specs script by
hand, so what you see driving a client is what the suite asserts on — keep them in step with the
specs:

| Scenario | State |
| --- | --- |
| `default` | Two personas (Kurisu answers, Amadeus available), a model chosen, a short streamed reply |
| `tool-call` | Assistant text interrupted by a `lookup` tool result, then the answer |
| `sub-agent` | A step delegated to a sub-agent mid-answer — the `sub-agent` tag and duration |
| `handoff` | Kurisu starts the answer, Amadeus finishes it: two bubbles, two speakers |
| `thinking` | A thinking chunk before the answer (the collapsible "Thinking" block) |
| `slow` | One chunk every 400 ms for a while — long enough to press Stop |
| `no-model` | A fresh account with no model chosen: the first message is refused with `NO_MODEL_SELECTED` |

The mock has no tool-approval flow: nothing in the client is driven by `tool_approval_request` from
here yet, and adding it means adding it to the mock first.

**Client tests — unit, e2e, instrumented, screenshot capture — run against the mock backend, never against a deployed one. The mock mirrors `backend/kurisuassistant/`; when the two disagree, the backend wins and the mock is fixed in the same PR as the protocol change.**

Commands: `npm test` (vitest, no build needed), and `npm run test:e2e:build` (vite build → `dist/` + `dist-electron/`) then `npm run test:e2e` (or `test:e2e:headed` for debugging).

**On a headless machine, run the e2e in Docker: `npm run test:e2e:build` then `npm run test:e2e:docker`.** Playwright drives real Electron, which cannot start without a display, so `npm run test:e2e` fails on a server or a container with no X — and installing `xvfb` needs root. The `mcr.microsoft.com/playwright` image ships both Xvfb and the GUI libraries, so the Docker route needs nothing but Docker. It mounts the package, runs as the calling uid so build artefacts stay owned by you, and sets `HOME=/tmp` and `--shm-size=1g` because Chromium needs a writable home and more than the default 64 MB of shared memory. **The image tag is pinned to the `@playwright/test` version (currently `v1.63.0-noble`) and must be bumped with it** — a mismatch fails with a browser-not-found error that reads like a missing install.

It invokes `./node_modules/.bin/playwright` rather than `npx playwright`, deliberately. `npx` with no TTY and closed stdin — which is what `docker run` gives it under `npm run` — blocks on its install prompt forever: Xvfb comes up, no node process ever starts, and the container sits there looking like a slow test run rather than a hang.

This is not a nicety: the e2e suite is the only one that cannot run on the host, and a WebSocket reconnect regression reached CI precisely because it was the suite nobody could run locally.
