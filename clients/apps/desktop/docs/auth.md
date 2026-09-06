# Authentication and storage

[← clients/desktop](../CLAUDE.md)

Signing in, staying signed in, and where each piece of that is kept. The rule
this document exists to protect: **no token, password or key goes in
localStorage.**

## Login and refresh
- Login → POST /login → access token (1h) + refresh token (30d) → held by apiClient and in `storage`'s module memory; written to the OS keychain only if rememberMe. Memory holds them either way, so authed asset URLs work in a no-remember-me session.
- App startup: `initializeAuth()` → sets refresh token on apiClient → validates via GET /users/me → auto-refreshes on 401 via axios interceptor
- Before that, `App.tsx` calls `GET /version`; a wire-protocol mismatch shows `UpdateRequiredScreen` instead of the login form. Its "Change server" button calls the auth store's `logout()` (tokens dropped, remember-me off) and clears the gate, so the login form renders with the stored Server URL editable. A 426 on any later request, or a 4426 socket close, raises the same screen the same way (#150; see [endpoints.md](endpoints.md))
- Token refresh: `POST /auth/refresh` with refresh_token body → returns new access_token. Coalesced (concurrent 401s share one refresh call). On success, persists new token if rememberMe. On failure, triggers logout.
- WebSocket auth failure (4001): wsManager auto-refreshes via apiClient.tryRefresh() then reconnects

## QR login (generator)
- `AccountSection` → "Show login QR" button opens `LoginQrDialog` (`src/components/settings/LoginQrDialog.tsx`). User re-enters their password (we don't store it in plaintext); dialog calls `apiClient.verifyCredentials()` (a passwordless variant of `/login` that doesn't overwrite the session token), then renders a QR via the `qrcode` npm package onto a canvas.
- Shared payload format (must match Android scanner): `{"v":1,"server":"https://...","username":"foo","password":"bar"}`. Server URL comes from `storage.getBackendUrl()`; username from `useAuthStore().user.username`.
- The dialog warns that the QR is a credential. There is no logout-after-share or rotation step — user is responsible.

## Token storage

Tokens live in the OS keychain through `electron/credentials.ts` (`safeStorage`:
Keychain, DPAPI, libsecret/kwallet), written to `credentials.json` in userData.
The renderer holds them in module memory for the life of the window, which is
what keeps `storage.getToken()` synchronous for the authed asset URLs that call
it on render paths; `storage.loadPersistedTokens()` fills that memory once
during `initializeAuth`, migrating and deleting any plaintext pair an older
build left in localStorage.

With no keychain available nothing is persisted at all — the session ends with
the app and "Remember me" is disabled with a line saying why. Falling back to
plaintext would reinstate the vulnerability the move was made to close (#91).
Memory holds the tokens either way, so a no-remember-me session still builds
working authed URLs.

## Storage keys (localStorage)

`kurisu_remember_me`, `kurisu_selected_model`, `kurisu_backend_url`, `kurisu_tts_backend`, `kurisu_tts_voice`, `kurisu_tts_language`, `kurisu_tts_emo_audio`, `kurisu_tts_emo_alpha`, `kurisu_tts_use_emo_text`, `kurisu_selected_persona_id`, `kurisu_persona_conversations`, `kurisu_media_volume`

Pre-split keys `kurisu_selected_agent_id` and `kurisu_agent_conversations` are removed once at startup by `storage.clearLegacyAgentKeys()` — both were caches that re-derive from the backend, so nothing is migrated.

`kurisu_auth_token` and `kurisu_refresh_token` are **gone from this list on purpose**. Tokens live in the OS keychain via `electron/credentials.ts`; `storage.loadPersistedTokens()` moves any pair an older build left here into it and deletes them. Do not add a token, password or key to localStorage — in Electron it is an unencrypted LevelDB under userData, readable by any process running as the user.
