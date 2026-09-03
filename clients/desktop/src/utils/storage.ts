/**
 * Persistent storage utility for auth tokens
 * Uses localStorage for simplicity in Electron renderer process
 */

const STORAGE_KEYS = {
  AUTH_TOKEN: 'kurisu_auth_token',
  REFRESH_TOKEN: 'kurisu_refresh_token',
  REMEMBER_ME: 'kurisu_remember_me',
  SELECTED_MODEL: 'kurisu_selected_model',
  TTS_VOICE: 'kurisu_tts_voice',
  TTS_LANGUAGE: 'kurisu_tts_language',
  TTS_AUTO_PLAY: 'kurisu_tts_auto_play',
  TTS_BACKEND: 'kurisu_tts_backend',
  BACKEND_URL: 'kurisu_backend_url',

  ASR_DEVICE_ID: 'kurisu_asr_device_id',
  SELECTED_AGENT_ID: 'kurisu_selected_agent_id',
  AGENT_CONVERSATIONS: 'kurisu_agent_conversations',
  ASR_LANGUAGE: 'kurisu_asr_language',
  ASR_ALWAYS_LISTEN: 'kurisu_asr_always_listen',
  ASR_MODE: 'kurisu_asr_mode',
  ASR_FIXED_MODEL: 'kurisu_asr_fixed_model',
  ASR_MODEL_MAP: 'kurisu_asr_model_map',
} as const;

export const storage = {
  /**
   * Save auth token to persistent storage
   */
  setToken(token: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
    } catch (error) {
      console.error('Failed to save token:', error);
    }
  },

  /**
   * Get auth token from persistent storage
   */
  getToken(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    } catch (error) {
      console.error('Failed to get token:', error);
      return null;
    }
  },

  /**
   * Remove auth token from storage
   */
  clearToken(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    } catch (error) {
      console.error('Failed to clear token:', error);
    }
  },

  setRefreshToken(token: string): void {
    try {
      localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, token);
    } catch (error) {
      console.error('Failed to save refresh token:', error);
    }
  },

  getRefreshToken(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    } catch (error) {
      console.error('Failed to get refresh token:', error);
      return null;
    }
  },

  clearRefreshToken(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
    } catch (error) {
      console.error('Failed to clear refresh token:', error);
    }
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

  setSelectedAgentId(id: number): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_AGENT_ID, id.toString());
    } catch (error) {
      console.error('Failed to save selected agent ID:', error);
    }
  },

  getSelectedAgentId(): number | null {
    try {
      const value = localStorage.getItem(STORAGE_KEYS.SELECTED_AGENT_ID);
      return value ? parseInt(value, 10) : null;
    } catch (error) {
      console.error('Failed to get selected agent ID:', error);
      return null;
    }
  },

  clearSelectedAgentId(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.SELECTED_AGENT_ID);
    } catch (error) {
      console.error('Failed to clear selected agent ID:', error);
    }
  },

  getAgentConversationMap(): Record<string, number> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.AGENT_CONVERSATIONS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  },

  getAgentConversationId(agentId: number | 'group'): number | null {
    const map = this.getAgentConversationMap();
    return map[String(agentId)] ?? null;
  },

  setAgentConversationId(agentId: number | 'group', conversationId: number): void {
    try {
      const map = this.getAgentConversationMap();
      map[String(agentId)] = conversationId;
      localStorage.setItem(STORAGE_KEYS.AGENT_CONVERSATIONS, JSON.stringify(map));
    } catch (error) {
      console.error('Failed to save agent conversation mapping:', error);
    }
  },

  clearAgentConversationId(agentId: number | 'group'): void {
    try {
      const map = this.getAgentConversationMap();
      delete map[String(agentId)];
      localStorage.setItem(STORAGE_KEYS.AGENT_CONVERSATIONS, JSON.stringify(map));
    } catch (error) {
      console.error('Failed to clear agent conversation mapping:', error);
    }
  },

  clearAllAgentConversations(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.AGENT_CONVERSATIONS);
    } catch (error) {
      console.error('Failed to clear all agent conversations:', error);
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
