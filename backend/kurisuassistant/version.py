"""Single source of truth for backend version + wire-protocol compatibility.

`__version__` is the human-readable backend release version (semver).

`WIRE_PROTOCOL` is a monotonically increasing integer bumped on **any breaking
change** to the wire format clients depend on (REST request/response shapes,
WebSocket event payloads, headers, auth flow, etc.). Clients ship with their
own `WIRE_PROTOCOL` constant; if the two don't match exactly, the client is
incompatible and must update.

Bumping rules:
- Add an optional field to a response → DO NOT bump.
- Rename / remove a field, change a field's type, change an event name, change
  required-ness, restructure auth handshake → BUMP.
- Bump rarely; treat each bump as a coordinated release across all clients.

Update log (most recent first):
- 3: The WebSocket no longer accepts the access token as a `?token=` query
     parameter. Clients authenticate the handshake with an
     `Authorization: Bearer` header, or — in a browser context, which cannot set
     headers on a WebSocket — by offering `kurisu.auth.bearer, <token>` as the
     subprotocol. Character asset routes also require authentication now, so a
     client must fetch those with the token attached rather than pointing an
     image or video element straight at the URL.
- 2: `GET /users/me` no longer returns `gemini_api_key` / `nvidia_api_key`.
     They are write-only now; the response carries `has_gemini_key` and
     `has_nvidia_key` booleans instead. Clients must stop pre-filling the key
     field from the profile, and must omit the key from a PATCH unless the user
     typed a new one — an older client would send back what it read and clear
     the stored key.
- 1: Initial wire protocol baseline.
"""

__version__ = "0.4.0"
WIRE_PROTOCOL = 3
