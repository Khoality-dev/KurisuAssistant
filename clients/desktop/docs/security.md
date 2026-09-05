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
- Still missing, tracked in #90: a Content-Security-Policy, a `will-navigate`
  guard, and a supported Electron major.

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
