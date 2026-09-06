# Kurisu Assistant Desktop

The Windows and Linux desktop client for [Kurisu Assistant](../../README.md).

See [Screens](docs/screens.md) for what the app looks like and the model it presents.

## Install

Download the latest installer from the [desktop releases page](https://github.com/Khoality-dev/KurisuAssistant-Client-Desktop/releases/latest).

- Windows: run the `.exe` installer.
- Linux: install the `.deb`, or make the `.AppImage` executable with `chmod +x` and open it.

The app checks for updates when it starts.

## Sign in

Enter your server's complete URL, including `http://` or `https://`, then enter your username and password. Registration is closed by default; on a fresh self-hosted server, sign in with `admin` / `admin`. Under **Settings → Account**, you can generate a QR code after re-entering your password for Android sign-in. The QR contains the username and password in plain text, so treat it as a credential.

## Everyday use

- **Workspace:** browse and edit folders allowed under **Settings → Host Access**.
- **Conversations:** choose the persona answering a conversation and resume earlier conversations.
- **Voice:** use the microphone button for dictation or trigger-word voice interaction. Configure ASR and TTS under **Settings → Voice** and **Settings → TTS & ASR**.
- **Images:** attach an image or drag one onto the composer; the selected model must support vision.
- **Assistant:** choose the account's model, tools, memory, and wake word.
- **Personas:** create names, prompts, voices, avatars, and character graphs. A conversation is bound to one persona.
- **Sub-Agents:** create task-only workers with their own models.
- **Tools & MCP:** connect tool servers and review approval requests before allowing calls.
- **Character:** configure animation, webcam vision, and face identities from Settings. `/live-animate` toggles the character window and `/vision` toggles webcam vision.

Typing `/` in the composer shows `/clear`, `/delete`, `/resume`, `/context`, `/persona`, `/refresh`, `/compact`, `/live-animate`, and `/vision`. There is no `/agents` command.

Before the first message, open **Settings → Assistant** and select a model. See the [desktop manual](../../docs/manual/desktop.md) for the settings list and camera limitation.

## Security

- **Host Access** is a boundary. A file call runs only when its path is already allowed or you explicitly approve the displayed path for that call. A stored tool approval cannot authorize an unrelated path. A permanent approval grants the exact path; a directory includes its subtree.
- Bash approval is per exact command. Approving `git status` approves nothing else.
- Starting a local MCP server prompts first and shows the exact command line. Playwright auto-start is off by default under **Settings → Tools & MCP**.
- The desktop is an MCP server for external clients on `127.0.0.1` only. It requires the bearer token shown under **Settings → Tools & MCP**. Anyone with that token can run commands on this machine.
- Sign-in tokens are stored in the operating-system keychain. Without a keychain, **Remember me** is disabled and the session ends when the app closes.

## Run from source

Requires Node.js 20 or newer and a running backend:

```bash
npm install
npm run electron:dev
```

Build an installer with `npm run electron:build`; output is written to `release/`.

Run tests with `npm test`. End-to-end tests use `npm run test:e2e:build && npm run test:e2e`.

## Client configuration

The server URL is entered on the login screen and saved locally. The default is `http://localhost:15597`; use the URL supplied by your server administrator for remote or LAN servers. See [`CLAUDE.md`](CLAUDE.md) for the architecture map and [`backend/docs/`](../../backend/docs/) for server protocol details.

## License

MIT. See the repository [LICENSE](../../LICENSE).
