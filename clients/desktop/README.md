# Kurisu Assistant Desktop

The Windows and Linux desktop client for [Kurisu Assistant](../../README.md).

## Install

Download the latest installer from the [desktop releases page](https://github.com/Khoality-dev/KurisuAssistant-Client-Desktop/releases/latest).

- Windows: run the `.exe` installer.
- Linux: install the `.deb`, or make the `.AppImage` executable with `chmod +x` and open it.

The app checks for updates when it starts.

## Sign in

Enter your server's complete URL, including `http://` or `https://`, then enter your username and password. Use **Register** to create an account on a new server. Under **Settings → Account**, you can generate a QR code for quick Android sign-in; treat it like a password.

## Everyday use

- **Workspace:** browse and edit folders allowed under **Settings → Host Access**.
- **Conversations:** switch between agents and resume earlier conversations.
- **Voice:** use the microphone button for dictation or trigger-word voice interaction. Configure ASR and TTS under **Settings → Voice** and **Settings → TTS & ASR**.
- **Images:** attach an image or drag one onto the composer; the selected model must support vision.
- **Agents:** create main agents with a model, personality, voice, avatar, memory, trigger word, and allowed tools.
- **Tools & MCP:** connect tool servers and review approval requests before allowing calls.
- **Character:** configure animation, webcam vision, and face identities from Settings. `/live-animate` toggles the character window and `/vision` toggles webcam vision.

Typing `/` in the composer shows commands such as `/clear`, `/resume`, `/delete`, `/agents`, `/refresh`, `/context`, and `/compact`.

## Run from source

Requires Node.js 20 or newer and a running backend:

```bash
npm install
npm run electron:dev
```

Build an installer with `npm run electron:build`; output is written to `release/`.

Run tests with `npm test`. End-to-end tests use `npm run test:e2e:build && npm run test:e2e`.

## Client configuration

The server URL is entered on the login screen and saved locally. The default is `https://localhost`; use the URL supplied by your server administrator for remote or LAN servers. See [`CLAUDE.md`](CLAUDE.md) for the architecture map and [`backend/docs/`](../../backend/docs/) for server protocol details.

## License

MIT. See the repository [LICENSE](../../LICENSE).
