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
- 1: Initial wire protocol baseline.
"""

__version__ = "0.2.0"
WIRE_PROTOCOL = 1
