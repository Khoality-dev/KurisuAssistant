# Kurisu Assistant

Kurisu Assistant is a personal AI assistant for text and voice conversations. It supports multiple customizable agents, persistent conversations and memory, image input, speech recognition, text-to-speech, tools, skills, and animated characters.

You use Kurisu Assistant through either the desktop app (Windows/Linux) or the Android app. Both clients connect to a Kurisu Assistant server.

## What you need

Before opening the app, make sure you have:

- A Kurisu Assistant server URL, such as `https://assistant.example.com` or `http://192.168.1.20:15597`
- A username and password for that server
- Microphone permission if you want voice input
- Camera permission only if you want face recognition, QR sign-in, or other vision features

If somebody else manages your server, ask them for the server URL and an account, then continue with [Install a client](#install-a-client). If you are running your own server, see [Self-hosting](#self-hosting).

## Install a client

### Desktop (Windows or Linux)

Download the latest installer from the [desktop releases page](https://github.com/Khoality-dev/KurisuAssistant-Client-Desktop/releases/latest).

- **Windows:** download and run the `.exe` installer.
- **Linux:** download the `.AppImage` or `.deb` package. If using an AppImage, make it executable before opening it:

  ```bash
  chmod +x KurisuAssistant*.AppImage
  ./KurisuAssistant*.AppImage
  ```

The desktop app checks for updates automatically.

### Android

Kurisu Assistant requires Android 8.0 or newer.

1. Download the latest APK from the [Android releases page](https://github.com/Khoality-dev/KurisuAssistant-Client-Android/releases/latest).
2. Open the APK on your phone.
3. If Android asks, allow installation from the browser or file manager you used to download it.
4. Finish the installation and open Kurisu Assistant.

The Android app can check for updates from **Settings**. Android may ask for permission before installing an update.

## Sign in

1. Enter the complete **Server URL**, including `http://` or `https://`.
2. Enter your username and password.
3. Leave **Remember me** enabled if this is your own device.
4. Select **Login**.

Use the **Register** tab to create your own account on a new server. A newly installed self-hosted server also creates an `admin` account with the password `admin`; do not use or expose those default credentials on an untrusted network.

Android users can select **Sign in with QR code** and scan a login QR code shown under **Desktop → Settings → Account**. The QR code contains the server address and login credentials, so treat it like a password and do not share or save screenshots of it.

> On a physical Android phone, `localhost` means the phone itself. Use the server computer's LAN address or public hostname instead.

## First-time setup

Complete these steps after your first login.

### 1. Choose an AI model provider

Open **Settings → Account** and configure at least one provider. The desktop client exposes all of the following options; Android currently exposes the Ollama URL:

- **Ollama:** enter the Ollama server URL. The server must be reachable from the Kurisu Assistant backend.
- **Google Gemini:** enter a Gemini API key.
- **NVIDIA NIM:** enter an NVIDIA API key.

Save the account settings, then refresh the model list. You can also select a **Summary Model** to enable conversation compaction and long-term agent memory. A larger **Context Size** keeps more conversation available to the model but uses more memory/VRAM with Ollama.

### 2. Create an agent

On desktop, open **Settings → Agents**. On Android, open the navigation drawer and select **Agents**. Then:

1. Select **Add** or **New Agent**.
2. Enter a name and select a model.
3. Add a description or system prompt explaining how the agent should behave.
4. Optionally choose a voice, avatar, trigger word, memory, and allowed tools.
5. Save the agent.

A **main agent** is a character you can chat with directly. A **sub-agent** is intended for delegated tasks and does not need voice or character settings.

### 3. Configure voice

Open **Settings → Voice** and **Settings → TTS & ASR** on desktop, or the corresponding settings pages on Android.

- Select an available speech-recognition model or routing mode.
- Set the recognition language, or leave it empty for automatic detection.
- Select a TTS backend and voice.
- Enable **TTS Auto-Play** if replies should be spoken automatically.
- Enable **Always Listen** only if you want the microphone kept active for trigger words or dictation.

Available voices and speech models depend on the services installed on your server.

## Using Kurisu Assistant

### Start a conversation

Select an agent, type a message, and press **Enter** or the send button. Use **Shift+Enter** for a new line. Replies stream into the conversation as they are generated; use the stop button or press **Escape** on desktop to cancel a response.

Kurisu Assistant remembers the most recent conversation for each agent. Use the **Conversations** page on desktop or the conversation list on Android to return to earlier chats.

### Add images

Use the attachment button to add an image to a message. On desktop, you can also drag images onto the message box. The selected model must support image input for the agent to understand it.

### Talk with an agent

Use the microphone control to start listening. After you stop speaking, the app transcribes your speech:

- Outside an active voice interaction, ordinary speech is placed in the message box so you can review it before sending.
- Saying an agent's configured trigger word starts an interactive conversation and sends the request automatically.
- During an active interaction, follow-up speech is sent automatically until the session becomes idle or you end it.

If transcription is inaccurate, choose the correct ASR language/model, reduce background noise, and check microphone permission in your operating system.

### Manage conversations with commands

Type `/` in the message box to see available commands. The common commands are:

| Command | Action |
| --- | --- |
| `/clear` | Start a new conversation while keeping the current one in history |
| `/resume` | Choose an earlier conversation to continue |
| `/delete` | Permanently delete the current conversation |
| `/agents` | Switch to another main agent |
| `/refresh` | Reload the current conversation from the server |
| `/context` | Show the current context/token breakdown |
| `/compact` | Summarize older context now |

Desktop also supports `/vision` to toggle webcam vision and `/live-animate` to toggle the animated character window. Android exposes the character view through the face button in the chat header.

### Give agents tools and skills

Use **Settings → Tools & MCP** to connect tool servers and choose which tools an agent may call. Use **Settings → Skills** to create or import reusable instructions.

Only enable tools you trust. Desktop host tools can access files or run commands within paths allowed under **Settings → Host Access**. The app may ask you to approve a tool call before it runs, depending on your permission settings.

### Use workspace and character features

The desktop **Workspace** provides a file explorer and editor for folders you have explicitly allowed. Character animation, face identities, camera vision, voices, and appearance are configured from their matching **Settings** sections. These features are optional and may require server-side models or assets.

## Troubleshooting

### The app cannot connect to the server

- Confirm the Server URL includes `http://` or `https://` and the correct port.
- Open the URL from the same device to confirm the host is reachable.
- On Android, use the server's LAN IP or hostname—not `localhost`.
- If the server uses a private or self-signed certificate, confirm that the device accepts it.
- Ask the server administrator to check the API and reverse-proxy logs.

### No models appear

- Check **Settings → Account** for the correct Ollama URL or cloud API key.
- Confirm Ollama has at least one model installed.
- Save the settings and refresh the model list.
- Make sure the backend, not only the client device, can reach the configured provider.

### Voice input or speech output does not work

- Grant microphone permission and check the selected input device.
- Verify the ASR and TTS services are running on the server.
- Select an available ASR model, TTS backend, and voice.
- Disable **Always Listen** if another application needs exclusive microphone access.
- If replies are generated but silent, enable **TTS Auto-Play** and check the selected speaker output.

### An agent cannot use a tool

- Confirm the tool or MCP server is enabled and passes its connection test.
- Edit the agent and include the tool in its allowed tools.
- Check **Host Access** and tool approval settings on desktop.
- Some tools execute on the client, so the desktop app must remain open while they run.

## Self-hosting

The backend is a FastAPI service backed by PostgreSQL/pgvector. Voice features additionally require the configured ASR and TTS services; the supplied Docker Compose stack expects NVIDIA container support and local checkouts of viXTTS and Universal Voice. You also need an Ollama service or a supported cloud model key.

Start with the detailed [backend setup guide](backend/README.md). Once its dependencies and Docker networks are configured:

```bash
cd backend
cp .env_template .env
# Review .env and the service paths in docker-compose.yml first.
docker compose up -d --build
docker compose logs -f api
```

Database migrations run when the API container starts. Back up both the `postgres-data` Docker volume and `backend/data/`; together they contain accounts, conversations, memories, uploaded images, voices, character assets, and the server's JWT secret.

Do not expose a fresh installation to the internet with its default `admin` / `admin` credentials. Use HTTPS and a reverse proxy for access outside a trusted local network.

## Run a client from source

### Desktop

Requires Node.js 20 or newer and a running backend:

```bash
cd clients/desktop
npm install
npm run electron:dev
```

Create an installer with `npm run electron:build`; output is written to `clients/desktop/release/`.

### Android

Requires JDK 17 and the Android SDK:

```bash
cd clients/android
./gradlew assembleDevDebug
```

The APK is written below `clients/android/app/build/outputs/apk/dev/debug/`. Use `./gradlew installDevDebug` to install it on a connected emulator or device.

## Documentation for contributors

This repository contains three independently built packages:

| Path | Purpose |
| --- | --- |
| [`backend/`](backend/) | API, agents, memory, speech, vision, tools, and database |
| [`clients/desktop/`](clients/desktop/) | React, Electron, and TypeScript desktop client |
| [`clients/android/`](clients/android/) | Kotlin and Jetpack Compose Android client |

Backend protocol and subsystem documentation is in [`backend/docs/`](backend/docs/). The [desktop client guide](clients/desktop/README.md) and package-level development notes contain build and testing commands. Keep client event handling in sync with the [REST API](backend/docs/API.md) and [WebSocket protocol](backend/docs/websocket.md) when changing the server contract.

## License

MIT. See [LICENSE](LICENSE).
