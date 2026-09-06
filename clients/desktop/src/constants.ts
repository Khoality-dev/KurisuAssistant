// Wire-protocol integer — must equal backend `WIRE_PROTOCOL` in
// KurisuAssistant/kurisuassistant/version.py. Bump on any breaking change to
// REST/WebSocket payloads, headers, or auth flow. Sent on every request via
// an axios interceptor and checked once on startup against `GET /version`.
export const WIRE_PROTOCOL = 5;

// The WebSocket handshake carries the access token as the second subprotocol
// entry. Must match WS_AUTH_SUBPROTOCOL in the backend's routers/ws.py.
export const WS_AUTH_SUBPROTOCOL = 'kurisu.auth.bearer';

// ...and the wire protocol as a third entry, `kurisu.wire.<n>`. A renderer is a
// browser context and cannot set `X-Wire-Protocol` on a WebSocket, so this is the
// only channel for it; the backend closes with 4426 on a mismatch, before it
// authenticates. Must match WS_WIRE_PROTOCOL_PREFIX in the backend's routers/ws.py.
export const WS_WIRE_SUBPROTOCOL_PREFIX = 'kurisu.wire.';

// Close code the backend uses for a wire-protocol mismatch (mirrors HTTP 426).
// Reconnecting cannot fix it, so the socket manager stops retrying on it.
export const WS_WIRE_PROTOCOL_MISMATCH = 4426;

// `code` on the WebSocket `error` event when the account has no model chosen yet.
// Not a failure: a new account's `assistants.model_name` is NULL because
// provisioning cannot pick one, so its first message has nothing to run on. It is
// handled apart from every other error code — a prompt that opens
// Settings → Assistant, not the red toast — because it is the first thing a new
// user meets and it is one click from fixed. Must match the code emitted by the
// backend's websocket/handlers.py.
export const WS_ERROR_NO_MODEL_SELECTED = 'NO_MODEL_SELECTED';

// The Playwright MCP server, pinned to an exact version.
//
// It is fetched from the npm registry at spawn time — the package is not
// bundled into the app — so an unpinned `npx @playwright/mcp` runs whatever
// that name resolves to on the day, with no consent step of its own. `-y`
// suppresses npx's install prompt, which otherwise blocks forever when there is
// no TTY. Keep the version equal to the `@playwright/mcp` dependency in
// package.json.
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.68';
export const PLAYWRIGHT_MCP_ARGS = ['-y', PLAYWRIGHT_MCP_PACKAGE];
