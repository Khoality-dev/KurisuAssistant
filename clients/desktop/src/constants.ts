// Wire-protocol integer — must equal backend `WIRE_PROTOCOL` in
// KurisuAssistant/kurisuassistant/version.py. Bump on any breaking change to
// REST/WebSocket payloads, headers, or auth flow. Sent on every request via
// an axios interceptor and checked once on startup against `GET /version`.
export const WIRE_PROTOCOL = 1;
