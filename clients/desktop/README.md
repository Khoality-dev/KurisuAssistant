# Kurisu Assistant — Desktop Client

Desktop client for [KurisuAssistant](https://github.com/Khoality-dev/KurisuAssistant) built with React, Electron, TypeScript, and Material-UI.

## Features

- **Streaming Chat** — Real-time WebSocket streaming with sentence-by-sentence display
- **Voice Input** — Silero VAD auto-detects speech end, transcribes via server-side faster-whisper
- **TTS Auto-Play** — Streams text-to-speech as the agent responds, with per-agent voice selection
- **Multi-Agent** — Create and switch between agents with custom prompts, models, voices, and tools
- **Character Animation** — Separate video call window with animated 2D characters: blink, breathing, lip sync, gesture-triggered pose transitions via a graph-based state machine
- **Vision Pipeline** — Webcam face recognition and gesture detection with real-time results
- **Skills** — Create, edit, and import/export instruction blocks that teach agents capabilities
- **Image Support** — Attach images to messages with vision model support
- **Conversation Management** — Sidebar with conversation list, session frame separators, infinite scroll pagination

## Tech Stack

- **Frontend**: React 18 + TypeScript
- **Desktop**: Electron 28
- **UI**: Material-UI v5
- **Animations**: Framer Motion
- **State**: Zustand
- **Build**: Vite
- **Character Engine**: Canvas-based compositor with 60fps rendering

## Getting Started

### Prerequisites

- Node.js 18+
- KurisuAssistant server running

### Install & Run

```bash
npm install
npm run electron:dev
```

### Build

```bash
npm run electron:build
```

Produces an installer in `release/`.

## Configuration

Server URL is configurable in the login screen and persisted to localStorage. Default: `https://localhost`.

## Project Structure

```
electron/
  main.ts                   Multi-window entry (main + character window)
  preload.ts                IPC bridge (platform + character window channels)
src/
  api/client.ts             Axios + WebSocket manager (chat + media streaming)
  components/
    LoginWindow.tsx          Login/register with server URL field
    MainWindow.tsx           Sidebar + chat layout
    ChatWidget.tsx           Chat UI, streaming, TTS, image attach, vision toggle
    MessageBubble.tsx        Message rendering with thinking blocks, TTS, actions
    AgentsWindow.tsx         Agent CRUD + character config
    ToolsWindow.tsx          MCP tools, built-in tools, skills management
    FacesWindow.tsx          Face identity CRUD + webcam vision controls
    SettingsWindow.tsx       Account + TTS settings
    CharacterConfigDialog.tsx  React Flow graph editor for pose trees
  hooks/
    useTTS.ts               TTS synthesis queue + playback
    useAudioAmplitude.ts    Audio amplitude for lip sync
  store/                    Zustand stores (auth, conversations, agents, vision)
  videocall/                Character animation engine
    CharacterRenderer.tsx    React wrapper for canvas compositor
    engine/
      CanvasCompositor.ts    60fps render: blink, breathing, lip sync, pose state machine
  CharacterWindowApp.tsx     IPC-driven renderer for character window
```

## License

See [LICENSE](LICENSE).
