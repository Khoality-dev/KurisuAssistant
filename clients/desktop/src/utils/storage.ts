/**
 * Persistent storage for preferences, and the in-memory half of token storage.
 *
 * Preferences live in localStorage. **Tokens do not.** They are held in module
 * memory for the life of the window and persisted through the main process into
 * the OS keychain (`electron/credentials.ts`), because localStorage in Electron
 * is an unencrypted LevelDB any process running as the user can read, and the
 * refresh token is 30 days of account access.
 *
 * `getToken()` stays synchronous — it is called while building authed URLs on
 * render paths — so the flow is: `loadPersistedTokens()` once at startup fills
 * memory from the keychain, and every later read is a memory read. Writes go to
 * memory first and to the keychain in the background.
 */

const STORAGE_KEYS = {
  REMEMBER_ME: 'kurisu_remember_me',
  SELECTED_MODEL: 'kurisu_selected_model',
  TTS_VOICE: 'kurisu_tts_voice',
  TTS_LANGUAGE: 'kurisu_tts_language',
  TTS_AUTO_PLAY: 'kurisu_tts_auto_play',
  TTS_BACKEND: 'kurisu_tts_backend',
  BACKEND_URL: 'kurisu_backend_url',

  ASR_DEVICE_ID: 'kurisu_asr_device_id',
  SELECTED_PERSONA_ID: 'kurisu_selected_persona_id',
  PERSONA_CONVERSATIONS: 'kurisu_persona_conversations',
  ASR_LANGUAGE: 'kurisu_asr_language',
  ASR_ALWAYS_LISTEN: 'kurisu_asr_always_listen',
  ASR_MODE: 'kurisu_asr_mode',
  ASR_FIXED_MODEL: 'kurisu_asr_fixed_model',
  ASR_MODEL_MAP: 'kurisu_asr_model_map',
} as const;

// Keys from before the agent/persona split. Both held a cache that re-derives from
// the backend on a miss, so nothing is migrated — the old entries are just dropped
// once at startup so they do not sit in localStorage forever.
const LEGACY_STORAGE_KEYS = [
  'kurisu_selected_agent_id',
  'kurisu_agent_conversations',
] as const;

// Where the tokens used to be kept. Read once during migration, then removed.
const LEGACY_TOKEN_KEYS = {
  AUTH_TOKEN: 'kurisu_auth_token',
  REFRESH_TOKEN: 'kurisu_refresh_token',
} as const;

/**
 * The tokens, for this window only. Never written to localStorage; the copy
 * that survives a restart is the encrypted one the main process holds.
 */
const tokens: { access: string | null; refresh: string | null } = {
  access: null,
  refresh: null,
};

/** False once we learn the OS has no keychain: then nothing persists at all. */
let secureStorageAvailable = true;

function credentialsBridge() {
  return typeof window !== 'undefined' ? window.electron?.credentials : undefined;
}

function rememberMeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.REMEMBER_ME) === 'true';
  } catch {
    return false;
  }
}

/**
 * Push the current pair to the keychain. Fire-and-forget by design.
 *
 * "Remember me" decides what crosses this line, not what the window holds:
 * memory always has the tokens while a session is open, which is what the
 * authed asset URLs read. Without remember-me nothing is written, and anything
 * previously written is dropped.
 */
function persistTokens(): void {
  const bridge = credentialsBridge();
  if (!bridge) return; // Vite dev server with no Electron: memory only.
  if (!rememberMeEnabled()) {
    bridge.clear().catch((error) => console.error('Failed to clear tokens:', error));
    return;
  }
  bridge
    .write({ accessToken: tokens.access, refreshToken: tokens.refresh })
    .then((stored) => {
      secureStorageAvailable = stored !== false;
      if (!stored) {
        console.warn('[storage] No OS keychain available — tokens are not persisted.');
      }
    })
    .catch((error) => console.error('Failed to persist tokens:', error));
}

/**
 * A key in the persona → conversation map. A number is a persona id. `'unbound'`
 * is the bucket for a conversation started while no persona was selected — the
 * client does not learn who answered until the first `stream_chunk` carries a
 * `persona_id`, and this keeps that conversation reachable in the meantime.
 * (It replaces the old `'group'` sentinel, which named a group-chat concept that
 * no longer exists.)
 */
export type PersonaConversationKey = number | 'unbound';

export const storage = {
  /**
   * Drop the pre-split cache keys. Safe to call at any time and cheap to repeat;
   * both keys were caches, so there is nothing to migrate.
   */
  clearLegacyAgentKeys(): void {
    try {
      for (const key of LEGACY_STORAGE_KEYS) {
        localStorage.removeItem(key);
      }
    } catch (error) {
      console.error('Failed to clear legacy agent storage keys:', error);
    }
  },

  /**
   * Fill memory from the keychain, once, before anything reads a token.
   *
   * Also migrates a pair left in localStorage by an older build: it is moved
   * into the keychain and the plaintext copies are deleted. If there is no
   * keychain to move them to, they are deleted anyway — an unencrypted 30-day
   * credential on disk is the thing being fixed, and the user can log in again.
   */
  async loadPersistedTokens(): Promise<void> {
    const bridge = credentialsBridge();

    let legacyAccess: string | null = null;
    let legacyRefresh: string | null = null;
    try {
      legacyAccess = localStorage.getItem(LEGACY_TOKEN_KEYS.AUTH_TOKEN);
      legacyRefresh = localStorage.getItem(LEGACY_TOKEN_KEYS.REFRESH_TOKEN);
      localStorage.removeItem(LEGACY_TOKEN_KEYS.AUTH_TOKEN);
      localStorage.removeItem(LEGACY_TOKEN_KEYS.REFRESH_TOKEN);
    } catch {
      /* no localStorage: nothing to migrate */
    }

    if (!bridge) {
      secureStorageAvailable = false;
      tokens.access = legacyAccess;
      tokens.refresh = legacyRefresh;
      return;
    }

    try {
      secureStorageAvailable = await bridge.isSecure();
      const stored = await bridge.read();
      tokens.access = stored.accessToken ?? legacyAccess;
      tokens.refresh = stored.refreshToken ?? legacyRefresh;
      // Only write when migrating, so a plain launch does not rewrite the file.
      if (!stored.refreshToken && (legacyAccess || legacyRefresh)) persistTokens();
    } catch (error) {
      console.error('Failed to read stored tokens:', error);
      tokens.access = legacyAccess;
      tokens.refresh = legacyRefresh;
    }
  },

  /** False when the OS offers no keychain, so "Remember me" cannot be honoured. */
  isTokenStorageSecure(): boolean {
    return secureStorageAvailable;
  },

  setToken(token: string): void {
    tokens.access = token;
    persistTokens();
  },

  getToken(): string | null {
    return tokens.access;
  },

  clearToken(): void {
    tokens.access = null;
    persistTokens();
  },

  setRefreshToken(token: string): void {
    tokens.refresh = token;
    persistTokens();
  },

  getRefreshToken(): string | null {
    return tokens.refresh;
  },

  clearRefreshToken(): void {
    tokens.refresh = null;
    persistTokens();
  },

  /** Drop both tokens from memory and from the keychain. */
  clearTokens(): void {
    tokens.access = null;
    tokens.refresh = null;
    credentialsBridge()?.clear().catch((error) => console.error('Failed to clear tokens:', error));
  },

  /**
   * Set remember me preference
   */
  setRememberMe(remember: boolean): void {
    try {
      localStorage.setItem(STORAGE_KEYS.REMEMBER_ME, remember.toString());
    } catch (error) {
      console.error('Failed to save remember me preference:', error);
    }
  },

  /**
   * Get remember me preference
   */
  getRememberMe(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEYS.REMEMBER_ME) === 'true';
    } catch (error) {
      console.error('Failed to get remember me preference:', error);
      return false;
    }
  },

  /**
   * Save selected model to persistent storage
   */
  setSelectedModel(model: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL, model);
    } catch (error) {
      console.error('Failed to save selected model:', error);
    }
  },

  /**
   * Get selected model from persistent storage
   */
  getSelectedModel(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.SELECTED_MODEL);
    } catch (error) {
      console.error('Failed to get selected model:', error);
      return null;
    }
  },

  /**
   * Save TTS voice to persistent storage
   */
  setTTSVoice(voice: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.TTS_VOICE, voice);
    } catch (error) {
      console.error('Failed to save TTS voice:', error);
    }
  },

  /**
   * Get TTS voice from persistent storage
   */
  getTTSVoice(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.TTS_VOICE);
    } catch (error) {
      console.error('Failed to get TTS voice:', error);
      return null;
    }
  },

  /**
   * Save TTS language to persistent storage
   */
  setTTSLanguage(language: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.TTS_LANGUAGE, language);
    } catch (error) {
      console.error('Failed to save TTS language:', error);
    }
  },

  /**
   * Get TTS language from persistent storage
   */
  getTTSLanguage(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.TTS_LANGUAGE);
    } catch (error) {
      console.error('Failed to get TTS language:', error);
      return null;
    }
  },

  /**
   * Save TTS auto-play preference
   */
  setTTSAutoPlay(autoPlay: boolean): void {
    try {
      localStorage.setItem(STORAGE_KEYS.TTS_AUTO_PLAY, autoPlay.toString());
    } catch (error) {
      console.error('Failed to save TTS auto-play preference:', error);
    }
  },

  /**
   * Get TTS auto-play preference
   */
  getTTSAutoPlay(): boolean {
    try {
      const value = localStorage.getItem(STORAGE_KEYS.TTS_AUTO_PLAY);
      return value === null ? true : value === 'true';
    } catch (error) {
      console.error('Failed to get TTS auto-play preference:', error);
      return true;
    }
  },

  /**
   * Save TTS backend to persistent storage
   */
  setTTSBackend(backend: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.TTS_BACKEND, backend);
    } catch (error) {
      console.error('Failed to save TTS backend:', error);
    }
  },

  /**
   * Get TTS backend from persistent storage.
   * Maps legacy `index-tts` settings to `vixtts`.
   */
  getTTSBackend(): string | null {
    try {
      const backend = localStorage.getItem(STORAGE_KEYS.TTS_BACKEND);
      if (backend === 'index-tts') {
        localStorage.setItem(STORAGE_KEYS.TTS_BACKEND, 'vixtts');
        return 'vixtts';
      }
      return backend;
    } catch (error) {
      console.error('Failed to get TTS backend:', error);
      return null;
    }
  },

  /**
   * Save viXTTS emotion settings to persistent storage
   */
  setTTSEmotionAudio(emoAudio: string): void {
    try {
      localStorage.setItem('kurisu_tts_emo_audio', emoAudio);
    } catch (error) {
      console.error('Failed to save TTS emotion audio:', error);
    }
  },

  getTTSEmotionAudio(): string | null {
    try {
      return localStorage.getItem('kurisu_tts_emo_audio');
    } catch (error) {
      console.error('Failed to get TTS emotion audio:', error);
      return null;
    }
  },

  setTTSEmotionAlpha(alpha: number): void {
    try {
      localStorage.setItem('kurisu_tts_emo_alpha', alpha.toString());
    } catch (error) {
      console.error('Failed to save TTS emotion alpha:', error);
    }
  },

  getTTSEmotionAlpha(): number {
    try {
      const value = localStorage.getItem('kurisu_tts_emo_alpha');
      return value ? parseFloat(value) : 1.0;
    } catch (error) {
      console.error('Failed to get TTS emotion alpha:', error);
      return 1.0;
    }
  },

  setTTSUseEmotionText(use: boolean): void {
    try {
      localStorage.setItem('kurisu_tts_use_emo_text', use.toString());
    } catch (error) {
      console.error('Failed to save TTS use emotion text:', error);
    }
  },

  getTTSUseEmotionText(): boolean {
    try {
      return localStorage.getItem('kurisu_tts_use_emo_text') === 'true';
    } catch (error) {
      console.error('Failed to get TTS use emotion text:', error);
      return false;
    }
  },

  setBackendUrl(url: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.BACKEND_URL, url);
    } catch (error) {
      console.error('Failed to save backend URL:', error);
    }
  },

  getBackendUrl(): string {
    try {
      return localStorage.getItem(STORAGE_KEYS.BACKEND_URL) || 'http://localhost:15597';
    } catch (error) {
      console.error('Failed to get backend URL:', error);
      return 'http://localhost:15597';
    }
  },

  setASRDeviceId(deviceId: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ASR_DEVICE_ID, deviceId);
    } catch (error) {
      console.error('Failed to save ASR device ID:', error);
    }
  },

  getASRDeviceId(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.ASR_DEVICE_ID);
    } catch (error) {
      console.error('Failed to get ASR device ID:', error);
      return null;
    }
  },

  setSelectedPersonaId(id: number): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_PERSONA_ID, id.toString());
    } catch (error) {
      console.error('Failed to save selected persona ID:', error);
    }
  },

  getSelectedPersonaId(): number | null {
    try {
      const value = localStorage.getItem(STORAGE_KEYS.SELECTED_PERSONA_ID);
      return value ? parseInt(value, 10) : null;
    } catch (error) {
      console.error('Failed to get selected persona ID:', error);
      return null;
    }
  },

  clearSelectedPersonaId(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.SELECTED_PERSONA_ID);
    } catch (error) {
      console.error('Failed to clear selected persona ID:', error);
    }
  },

  getPersonaConversationMap(): Record<string, number> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PERSONA_CONVERSATIONS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  },

  getPersonaConversationId(personaId: PersonaConversationKey): number | null {
    const map = this.getPersonaConversationMap();
    return map[String(personaId)] ?? null;
  },

  setPersonaConversationId(personaId: PersonaConversationKey, conversationId: number): void {
    try {
      const map = this.getPersonaConversationMap();
      map[String(personaId)] = conversationId;
      localStorage.setItem(STORAGE_KEYS.PERSONA_CONVERSATIONS, JSON.stringify(map));
    } catch (error) {
      console.error('Failed to save persona conversation mapping:', error);
    }
  },

  clearPersonaConversationId(personaId: PersonaConversationKey): void {
    try {
      const map = this.getPersonaConversationMap();
      delete map[String(personaId)];
      localStorage.setItem(STORAGE_KEYS.PERSONA_CONVERSATIONS, JSON.stringify(map));
    } catch (error) {
      console.error('Failed to clear persona conversation mapping:', error);
    }
  },

  clearAllPersonaConversations(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.PERSONA_CONVERSATIONS);
    } catch (error) {
      console.error('Failed to clear all persona conversations:', error);
    }
  },

  setASRLanguage(language: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ASR_LANGUAGE, language);
    } catch (error) {
      console.error('Failed to save ASR language:', error);
    }
  },

  getASRLanguage(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.ASR_LANGUAGE);
    } catch (error) {
      console.error('Failed to get ASR language:', error);
      return null;
    }
  },

  clearASRLanguage(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.ASR_LANGUAGE);
    } catch (error) {
      console.error('Failed to clear ASR language:', error);
    }
  },

  /** Always-listen: keep mic active for trigger word detection. Default true. */
  getASRAlwaysListen(): boolean {
    try {
      const v = localStorage.getItem(STORAGE_KEYS.ASR_ALWAYS_LISTEN);
      return v === 'true';
    } catch {
      return true;
    }
  },

  setASRAlwaysListen(enabled: boolean): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ASR_ALWAYS_LISTEN, enabled.toString());
    } catch (error) {
      console.error('Failed to save ASR always-listen:', error);
    }
  },

  /** ASR mode: 'fixed' or 'routing'. Default 'fixed'. */
  getASRMode(): 'fixed' | 'routing' {
    try {
      const v = localStorage.getItem(STORAGE_KEYS.ASR_MODE);
      return v === 'routing' ? 'routing' : 'fixed';
    } catch {
      return 'fixed';
    }
  },

  setASRMode(mode: 'fixed' | 'routing'): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ASR_MODE, mode);
    } catch (error) {
      console.error('Failed to save ASR mode:', error);
    }
  },

  /** Fixed model name for fixed mode. Empty = server default. */
  getASRFixedModel(): string {
    try {
      return localStorage.getItem(STORAGE_KEYS.ASR_FIXED_MODEL) || '';
    } catch {
      return '';
    }
  },

  setASRFixedModel(model: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ASR_FIXED_MODEL, model);
    } catch (error) {
      console.error('Failed to save ASR fixed model:', error);
    }
  },

  /** Language → ASR model mapping. Each entry: { language, model } */
  getASRModelMap(): Array<{ language: string; model: string }> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ASR_MODEL_MAP);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  setASRModelMap(map: Array<{ language: string; model: string }>): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ASR_MODEL_MAP, JSON.stringify(map));
    } catch (error) {
      console.error('Failed to save ASR model map:', error);
    }
  },

  /** Look up the model for a given language code. Returns undefined if no mapping. */
  getASRModelForLanguage(language: string): string | undefined {
    const map = this.getASRModelMap();
    const entry = map.find((e) => e.language === language);
    return entry?.model;
  },
};
