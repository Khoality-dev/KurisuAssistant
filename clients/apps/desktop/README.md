# Kurisu Assistant Desktop

The Windows and Linux desktop client for [Kurisu Assistant](../../../README.md).

See [Screens](docs/screens.md) for what the app looks like and the model it presents.

## Install

Download the latest installer from the [desktop releases page](https://github.com/Khoality-dev/KurisuAssistant/releases/latest).

- Windows: run the `.exe` installer.
- Linux: install the `.deb`, or make the `.AppImage` executable with `chmod +x` and open it.

The app checks for updates when it starts.

## Sign in

Enter your server's complete URL, including `http://` or `https://`, then enter your username and password. On a fresh self-hosted server, register in the app; you cannot sign in until the server operator activates your account by following the [server setup tutorial](../../../README.md#set-up-your-own-server). Under **Settings → Account**, you can generate a QR code after re-entering your password for Android sign-in. The QR contains the username and password in plain text, so treat it as a credential.

## Everyday use

- **Workspace:** browse and edit this computer's files and your Kurisu Drive side by side. What the assistant's own file tools may reach is set under **Settings → Host Access**.
- **Conversations:** find and reopen earlier conversations, newest first.
- **Model:** pick the account's model from the menu beside the persona in the chat header.
- **Voice:** turn on voice mode with the headset button in the chat header; say the wake word to start talking. Configure the microphone and speech under **Settings → Voice** and **Settings → TTS & ASR**, where **Generate TTS During Responses** turns spoken replies on or off.
- **Images:** drag an image onto the message box; the selected model must support vision.
- **Assistant:** set the wake word, memory, extended thinking and deferred tools.
- **Personas:** create names, prompts, voices, avatars, and 2D or 3D characters. The persona picked in the chat header or here answers every conversation, on every device.
- **Tools:** see every tool the assistant has, add MCP servers, and choose how much runs without asking with the permission mode beside the message box.
- **Character:** show the animated character in the chat with the face button in the chat header or `/live-animate`, and pop it out into its own window. `/vision` turns on webcam vision; face identities are under Settings.

Typing `/` in the composer shows `/clear`, `/delete`, `/resume`, `/context`, `/persona`, `/refresh`, `/compact`, `/live-animate`, and `/vision`. There is no `/agents` command.

A new account is walked through choosing a model the first time it signs in. Without one, the first message asks you to choose a model from the chat header.

The settings sections are **Account**, **Voice**, **TTS & ASR**, **Appearance**, **Assistant**, **Personas**, **Tools**, **Skills**, **Kurisu Drive**, **Notifications**, **Host Access**, **Face Identities**, and **Extensions**.

`/vision` uses the server's camera pipeline. Its body-pose stage requires CUDA, and the default server does not give the API a GPU. Text, tools, memory, and speech still work on a CPU-only server.

## Security

- **Host Access** is a boundary. A file call runs only when its path is already allowed or you explicitly approve the displayed path for that call. A stored tool approval cannot authorize an unrelated path. A permanent approval grants the exact path; a directory includes its subtree.
- Bash approval is per exact command. Approving `git status` approves nothing else.
- Starting a local MCP server prompts first and shows the exact command line. Playwright auto-start is off by default under **Settings → Tools**.
- The desktop is an MCP server for external clients on `127.0.0.1` only. It requires the bearer token shown under **Settings → Host Access**. Anyone with that token can run commands on this machine.
- Sign-in tokens are stored in the operating-system keychain. Without a keychain, **Remember me** is disabled and the session ends when the app closes.

## Run from source

Requires Node.js 22.12 or newer and a running backend. Dependencies install once for the whole TypeScript workspace, from `clients/`:

```bash
cd ../..          # clients/
npm ci
cd apps/desktop
npm run electron:dev
```

Build an installer with `npm run electron:build`; output is written to `release/`.

Run tests with `npm test`. End-to-end tests use `npm run test:e2e:build && npm run test:e2e`.

## Client configuration

The server URL is entered on the login screen and saved locally. The default is `http://localhost:15597`; use the URL supplied by your server administrator for remote or LAN servers. See [`CLAUDE.md`](CLAUDE.md) for the architecture map and [`backend/docs/`](../../../backend/docs/) for server protocol details.

## License

MIT. See the repository [LICENSE](../../../LICENSE).
