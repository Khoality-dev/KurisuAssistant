# Kurisu Assistant — Desktop Client

Desktop client for [KurisuAssistant](../../README.md), built with React, Electron, TypeScript, and Material-UI. Lives in `clients/desktop/` of the monorepo; the server it talks to is in [`backend/`](../../backend/).

## Features

- **Streaming Chat** — Real-time WebSocket streaming with sentence-by-sentence display
- **Voice Input** — Silero VAD auto-detects speech end, transcribes via server-side ASR
- **TTS Auto-Play** — Streams text-to-speech as the agent responds, with per-agent voice selection
- **Multi-Agent** — Create and switch between agents with custom prompts, models, voices, and tools
- **Workspace** — Built-in file explorer and Monaco editor, with per-agent host tools sandboxed to allowed paths
- **MCP Servers** — Run local stdio/SSE MCP servers and expose their tools to agents
- **Character Animation** — Separate video call window with animated 2D characters: blink, breathing, lip sync, gesture-triggered pose transitions via a graph-based state machine
- **Vision Pipeline** — Webcam face recognition and gesture detection with real-time results
- **Skills** — Create, edit, and import/export instruction blocks that teach agents capabilities
- **Image Support** — Attach images to messages with vision model support
- **Auto-Update** — Checks GitHub Releases on startup and installs updates in the background

## Tech Stack

- **Frontend**: React 18 + TypeScript
- **Desktop**: Electron 28
- **UI**: Material-UI v5, Framer Motion
- **State**: Zustand
- **Build**: Vite, electron-builder
- **Tests**: Vitest (unit), Playwright (Electron end-to-end)

## Getting Started

### Prerequisites

- Node.js 20+
- A running KurisuAssistant backend

### Install & Run

```bash
npm install
npm run electron:dev
```

### Build

```bash
npm run electron:build
```

Produces installers in `release/`.

### Tests

```bash
npm test                                   # unit tests
npm run test:e2e:build && npm run test:e2e # Playwright end-to-end
```

## Configuration

Server URL is configurable in the login screen and persisted to localStorage. Default: `https://localhost`.

## Releases

Push a `desktop-vX.Y.Z` tag on the monorepo. The root workflow `.github/workflows/desktop-build.yml` builds Windows and Linux packages and publishes them as release `vX.Y.Z` on `Khoality-dev/KurisuAssistant-Client-Desktop`, which is where installed apps look for updates (see `build.publish` in `package.json`).

## Project Structure

```
electron/
  main.ts                   Multi-window entry, auto-updater, IPC registration
  mcp.ts                    MCP server manager (stdio/SSE), tool discovery/execution
  hostTools.ts              Sandboxed per-agent host tools (read/write/edit/search/bash)
  appTools.ts               App config tools for agents (agent CRUD, MCP, vision, browser)
  explorerIPC.ts            File explorer IPC
  preload.ts                contextBridge surface
src/
  api/                      Axios + WebSocket client, API types
  components/
    layout/                 ActivityBar | MainContent | ChatPanel three-panel shell
    explorer/               File explorer, tabs, Monaco editor
    conversations/          Conversation list
    settings/               Settings sections (account, TTS, agents, MCP, tools, skills, faces, ...)
    chat/                   Chat widget, composer, message bubbles
    character/              React Flow pose-graph editor and preview
  hooks/                    TTS queue, audio amplitude, webcam capture, ...
  store/                    Zustand stores
  videocall/                Character animation engine (canvas compositor)
tests/                      Playwright specs and mock backend
```

See `CLAUDE.md` for the detailed architecture map.

## License

MIT. See the repository [LICENSE](../../LICENSE).
