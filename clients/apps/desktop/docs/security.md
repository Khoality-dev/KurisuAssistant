# Security model

[← clients/desktop](../CLAUDE.md)

What this client refuses to do, and why each refusal is where it is. Most of it
is here because it was once the other way round; the issue numbers are the
record.

## The renderer

- `contextIsolation` on and `nodeIntegration` off for both windows.
- Message rendering uses `react-markdown` with no `rehype-raw` and no
  `dangerouslySetInnerHTML`, so remote content has no HTML injection path.
- A stored token is validated against the backend on startup, never trusted on
  sight.
- Self-signed certificates are accepted through the `certificate-error` handler,
  for direct HTTPS to a backend on the local network.
- A **Content-Security-Policy** on every response, and **navigation guards** on
  every window. Both live in `electron/webSecurity.ts`, which imports nothing
  from Electron so the decisions can be unit-tested directly; `main.ts` does the
  wiring. See [The policy](#the-policy) below.
- Electron is kept on a **supported major** (43 as of #90, up from 28). Only the
  newest three receive security fixes, and this renderer displays whatever a
  remote server sends.

## The policy

Set as a response header from the main process rather than a `<meta>` tag in
`index.html`, because the packaged app serves its documents through the `file:`
and `local-file:` handlers, which never pass through that markup. It is applied
to the packaged app only: a dev run loads from Vite, whose HMR client needs
`unsafe-eval`, and pinning a policy there would describe the dev server rather
than the product. The e2e suite runs the packaged path, so the policy is under
test.

| Directive | Why it is what it is |
| --- | --- |
| `default-src 'self'` | Deny first. Everything below is something the app demonstrably does. |
| `script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net` | `wasm-unsafe-eval` compiles the Silero VAD model through onnxruntime-web; without it voice interaction stops. The CDN is there because `@monaco-editor/react` fetches Monaco at runtime — nothing calls `loader.config()`. **That is the one real hole in this policy**, and closing it means bundling Monaco locally, which would also make the file editor work offline. |
| `style-src 'self' 'unsafe-inline'` | MUI and Emotion inject `<style>` elements as components render. Not tightenable without replacing the styling engine. |
| `font-src 'self' data:` | The bundled Plus Jakarta Sans faces. |
| `img-src 'self' data: blob: local-file: file: http: https:` | Avatars and face photos come from the user's own backend, whose address the user types — no host can be named, and `http:` has to be allowed because a LAN backend is the normal case. `blob:` is `authedAsset`, which fetches with a token and hands back an object URL. |
| `media-src` (same set) | Synthesized speech arrives as a blob; character transition videos are read from disk. |
| `connect-src 'self' data: blob: http: https: ws: wss:` | REST and the chat socket to that same user-configured backend. |
| `worker-src 'self' blob:` | onnxruntime-web and Monaco both start workers, Monaco's from a blob. |
| `object-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'self'` | Nothing here embeds plugins, frames anything, submits a form, or rewrites the document base. |

**What the policy cannot do.** The backend address is the user's to choose, so
`connect-src` and `img-src` cannot name a host and cannot insist on TLS. The
policy therefore constrains *what kind of thing* the renderer may load, not
*from whom* — it stops injected script and framed content, and it does not stop
a hostile backend from being a hostile backend.

## Navigation

`setWindowOpenHandler` denies every `window.open`, and `will-navigate` refuses
any target that is not the app's own document (`file:`, `local-file:`, or the
dev server when one is running). Both apply to the main window and the character
window. An http(s) target that was refused is handed to `shell.openExternal`, so
a link in an assistant message opens in the system browser — where it has no
preload, no IPC and no access to this process. A `javascript:` or `file:` target
is refused outright and never handed to the OS.

## Tokens

In the OS keychain (`safeStorage`), never in localStorage — matching what the
Android client always did with EncryptedSharedPreferences. Details and the
no-keychain case in [auth.md](auth.md#token-storage).

## The built-in MCP server

`electron/mcpServer.ts` publishes every host and app tool over HTTP+SSE for an
external MCP client, and starts with the app. Four properties hold it shut, and
they only work together:

1. **Loopback only.** `listen(port, '127.0.0.1')`. With no host argument Node
   binds every interface, which put `host_bash` within reach of the LAN.
2. **No CORS headers, and no `OPTIONS` answer.** The wildcard
   `Access-Control-Allow-Origin: *` it used to send let any page the user
   visited complete the SSE handshake.
3. **Browser headers refused.** `Origin`, `Referer`, `Sec-Fetch-Site/Dest/User`
   — set by browsers, sent by no MCP client. **Not** `Sec-Fetch-Mode`: Node's
   own `fetch` sends it, so testing that header refuses every real client. The
   unit tests passed with it in; `tests/mcpServer.spec.ts` caught it.
4. **A bearer token** on everything but `/health`, minted on first run into
   `settings.json` and shown in Settings → Tools & MCP. Loopback is not an
   identity: another account on the machine can open a socket too.

The decision function is `electron/mcpServerAuth.ts`, free of electron imports
so it is unit-tested directly.

## Host tools

`allowed_paths` is a boundary, enforced in `executeHostTool` — a file tool whose
target is outside every grant is refused, not merely prompted. Grants are the
persisted list, this session's approvals, and the path just approved for the
current call. "Always" stores the exact path, and paths are compared through
`fs.realpathSync` so a symlink out of an allowed directory does not pass a
prefix test.

Bash is exempt and approved per exact normalised command instead: a shell
command reaches wherever it likes from any working directory, so calling that
directory a sandbox would be theatre. See `electron/hostToolPolicy.ts`.

## Spawning local programs

No stdio MCP server starts without consent for that exact command line, whoever
asked — the settings form, `app_add_mcp_server` (a row a model composes), or a
config from the backend. Consent is keyed on the command, not the server name,
so renaming keeps it and editing what it runs asks again
(`electron/mcpConsent.ts`).
