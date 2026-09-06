# Kurisu Assistant

![Kurisu Assistant banner](docs/assets/kurisu-assistant-banner.png)

Kurisu Assistant is a personal AI assistant for text and voice conversations. One assistant per account owns the model, tools and memory; you give it as many personas as you like — a name, a personality, a voice and a face — and pick which one answers. It also supports persistent conversations and memory, image input, speech recognition, text-to-speech, tools, skills, and animated characters.

The project is split into a server and two clients. Pick the guide that matches what you want to do:

| Guide | For | Start here |
| --- | --- | --- |
| [User manual](docs/manual/README.md) | Installing, first run, everyday use, and recovery | Start-to-finish user instructions |
| [Backend](backend/README.md) | Running your own server | Docker setup, providers, data, backups |
| [Desktop client](clients/desktop/README.md) | Windows and Linux users | Install, sign in, chat, voice, tools |
| [Android client](clients/android/README.md) | Android users | Install the APK, permissions, mobile voice |

Each package documents itself. For pictures of the apps, see
**[Android screens](clients/android/docs/screens.md)** and
**[Desktop screens](clients/desktop/docs/screens.md)**; for the model behind them —
one assistant, its personas, and the sub-agents it calls — see
**[assistant architecture](backend/docs/agents.md)**.

| | | |
| --- | --- | --- |
| ![Chats](clients/android/docs/assets/01-chats.png) | ![A conversation](clients/android/docs/assets/02-chat.png) | ![Assistant](clients/android/docs/assets/05-assistant.png) |
| Conversations, labelled by the persona answering | A tool call, shown as a rail | One assistant: model, tools, memory, wake word |

## Quick start for users

You need a Kurisu Assistant server URL and an account. If someone else hosts the server, ask them for both. If you are hosting it yourself, follow the [backend guide](backend/README.md) first.

1. Install the [desktop client](https://github.com/Khoality-dev/KurisuAssistant-Client-Desktop/releases/latest) or [Android client](https://github.com/Khoality-dev/KurisuAssistant-Client-Android/releases/latest).
2. Open the app and enter the complete server URL, including `http://` or `https://`.
3. On a fresh self-hosted server, sign in with `admin` / `admin`. Registration is closed by default even though the clients show a **Register** tab.
4. On desktop, open **Settings → Assistant**; on Android, open **Assistant** from the drawer. Select a model. The first message fails until a model is selected.
5. Keep the default persona or create one using the client-specific guide, then start chatting. Grant microphone or camera permission only when you want those features.

On a physical Android phone, `localhost` means the phone itself. Use the server computer's LAN address or public hostname instead.

## Shared first-run checklist

After signing in, configure at least one model provider under **Settings → Account**. Both clients support Ollama, Google Gemini, NVIDIA NIM and Poe; enter a provider's API key there and its models appear in the model pickers.

Your account already has one assistant and one persona. Select the assistant's model, and optionally its tools, memory and voice wake word — those belong to the assistant, so they do not change when you switch persona. Then give the persona (or a new one) a personality, voice and avatar. A new conversation silently uses your default persona; the chat header switches persona for one conversation.

For voice conversations, select an ASR language/model and TTS backend, then enable **TTS Auto-Play**. Enable **Always Listen** only when you want the microphone kept active for trigger words or dictation. Available models and voices depend on the services installed on the server.

## Common safety notes

- A fresh self-hosted server seeds `admin` / `admin`, and there is currently no way to change that password. Do not expose a fresh server on an untrusted network.
- Treat login QR codes and API keys like passwords.
- Only enable tools you trust. Desktop host tools can access files or run commands within paths allowed under **Host Access**.
- Back up the database, `data/`, and `.env` together by following [Backup and restore](docs/manual/backup-and-restore.md).

## Troubleshooting

- **Cannot connect:** check the complete URL, port, network reachability, and whether Android is incorrectly using `localhost`.
- **No models:** verify the provider URL/key from the backend's point of view, then save settings and refresh models.
- **Voice fails:** grant microphone permission, choose an ASR/TTS model, and ask the server operator to check service logs.
- **Tool fails:** confirm the tool server passes its connection test, the assistant or sub-agent is allowed to use the tool, and any approval prompt is accepted.

For symptom-by-symptom checks, see [Troubleshooting](docs/manual/troubleshooting.md).

See the [backend documentation](backend/docs/) for API, WebSocket, speech, vision, tools, and development details.

## License

MIT. See [LICENSE](LICENSE).
