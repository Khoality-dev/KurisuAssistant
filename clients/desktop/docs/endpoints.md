# Backend endpoints

[← clients/desktop](../CLAUDE.md)

The REST and WebSocket surface this client calls. The contract itself lives in the backend (`../../backend/docs/API.md`, `../../backend/docs/websocket.md`); this is the subset the desktop uses.

- `POST /login`, `POST /register` — Auth, returns JWT
- `GET /version` — `{backend_version, wire_protocol}`; the client's `WIRE_PROTOCOL` must match exactly (HTTP 426 / WebSocket close 4426 otherwise). `App.tsx` checks it at startup and, on a mismatch, replaces the UI with `UpdateRequiredScreen`, which says which side is behind (`src/utils/wireProtocol.ts`) and whose "Change server" signs out and returns to the login form. The same screen is raised after startup by a 426 on any request — the axios interceptor in `src/api/client.ts` reads the server's numbers from the 426 body (`{detail: "wire_protocol_mismatch", client_wire_protocol, server_wire_protocol, backend_version}`) and calls the `onProtocolMismatch` callback — and by a 4426 socket close, which carries no numbers, so `wsManager` asks `apiClient.reportProtocolMismatch()` to fetch `/version` (exempt from the gate) first (#150)
- `GET /conversations` (?persona_id= for latest by persona), `GET /conversations/{id}`, `DELETE /conversations/{id}`, `PATCH /conversations/{id}` `{title?, persona_id?}` — Conversation CRUD (`persona_id: null` unbinds)
- `/ws/chat` — WebSocket streaming chat (JSON events; auth + wire protocol declared in the handshake subprotocols)
- `GET /models` — Available LLM models: `{models: [{name, provider}], unavailable: [{provider, detail}]}`. `unavailable` lists the providers the server could not reach, so the list is real but partial; when no provider answered at all the response is a 502 whose `detail` names the failure (#151). `apiClient.getModelsWithStatus()` returns both halves; `getModels()` just the models. The Assistant screen shows `unavailable` as a warning, and every settings screen that loads the list shows the 502's `detail` rather than a generic failure
- `GET /users/me`, `PUT /users/me` — User profile
- `GET /images/{uuid}`, `GET /images/u/{uuid}`, `POST /images` — Image upload/fetch. **Neither GET is public** (#154): both take the token, and because these URLs go into `<img src=...>` — which cannot set a header — `apiClient.getImageUrl` / `getUserImageUrl` put it in the query string. `/images/{uuid}` returns 404, not 403, for an image belonging to another account.
- `POST /tts`, `GET /tts/voices`, `GET /tts/models` — TTS synthesis, voice listing, and the TTS model list. `/tts/models` answers 502 when the speech service is unreachable, and `{models: []}` when it is up but lists nothing; `useTTS.loadBackends` keeps `backends` empty either way and exposes the reason as `backendsError`, which the TTS settings picker shows. There is no client-side fallback list any more — it offered models that did not exist (#151)
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


## Vision frames are binary

A webcam frame goes out as a WebSocket binary message built by
`src/api/binaryFrame.ts` — `[version][type][header length][JSON header][JPEG]` —
rather than base64 inside a JSON event, so pixels never queue in front of the
assistant's next token (#111, wire protocol 6). `vision_start` and `vision_stop`
remain JSON events.
