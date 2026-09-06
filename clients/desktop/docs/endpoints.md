# Backend endpoints

[← clients/desktop](../CLAUDE.md)

The REST and WebSocket surface this client calls. The contract itself lives in the backend (`../../backend/docs/API.md`, `../../backend/docs/websocket.md`); this is the subset the desktop uses.

- `POST /login`, `POST /register` — Auth, returns JWT
- `GET /version` — `{backend_version, wire_protocol}`; the client's `WIRE_PROTOCOL` must match exactly (HTTP 426 / WebSocket close 4426 otherwise)
- `GET /conversations` (?persona_id= for latest by persona), `GET /conversations/{id}`, `DELETE /conversations/{id}`, `PATCH /conversations/{id}` `{title?, persona_id?}` — Conversation CRUD (`persona_id: null` unbinds)
- `/ws/chat` — WebSocket streaming chat (JSON events; auth + wire protocol declared in the handshake subprotocols)
- `GET /models` — Available LLM models (`{models: string[]}`)
- `GET /users/me`, `PUT /users/me` — User profile
- `GET /images/{uuid}`, `POST /images` — Image upload/fetch
- `POST /tts`, `GET /tts/voices`, `GET /tts/backends` — TTS synthesis and voice listing
- `GET /assistant`, `PATCH /assistant` — the user's single assistant (model, provider, tools, think, deferred tools, memory, wake word, default persona). No POST, no DELETE, no id: it is created at registration.
- `GET /personas`, `POST /personas`, `GET|PATCH|DELETE /personas/{id}`, `PATCH /personas/{id}/enabled`, `GET /personas/{id}/export`, `POST /personas/import` — Persona CRUD (presentation only)
- `GET /sub-agents`, `POST /sub-agents`, `GET|PATCH|DELETE /sub-agents/{id}`, `PATCH /sub-agents/{id}/enabled`, `GET /sub-agents/{id}/export`, `POST /sub-agents/import` — Sub-agent CRUD (task-only workers)
- `GET /tools` — Available tools for the assistant and sub-agents
- `POST /character-assets/upload-base?persona_id=&pose_id=` — Upload base portrait → `{persona_id}/{pose_id}/base.png`
- `POST /character-assets/compute-patch?persona_id=&pose_id=&part=&index=` — Upload keyframe, backend diffs → `{persona_id}/{pose_id}/{part}_{index}.png`
- `POST /character-assets/upload-video?persona_id=&edge_id=` — Upload transition video → `{persona_id}/edges/{edge_id}.mp4|.webm`
- `GET /character-assets/{persona_id}/{pose_id}/{filename}` — Serve pose asset (base/patch image, no-cache)
- `GET /character-assets/{persona_id}/edges/{edge_id}` — Serve transition video (no-cache)
- `PATCH /character-assets/{persona_id}/character-config` — Update pose tree config (cleans up orphaned assets incl. videos)
- `POST /character-assets/{persona_id}/migrate-ids` — Rename asset files/folders on disk to match migrated IDs
- `GET /faces`, `POST /faces`, `GET /faces/{id}`, `DELETE /faces/{id}` — Face identity CRUD
- `POST /faces/{id}/photos`, `DELETE /faces/{id}/photos/{photo_id}` — Face photo management
- `GET /faces/{id}/photos/{photo_id}/image` — Serve face photo image
- `GET /skills`, `POST /skills`, `PATCH /skills/{id}`, `DELETE /skills/{id}` — Skill CRUD (user-editable instruction blocks)
- `GET /mcp-servers`, `POST /mcp-servers`, `PATCH /mcp-servers/{id}`, `DELETE /mcp-servers/{id}` — MCP server CRUD (location: server|client)
- `POST /mcp-servers/{id}/test` — Test MCP server connectivity (server-side only)
