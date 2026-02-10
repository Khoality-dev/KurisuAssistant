/**
 * Persistent storage utility for auth tokens
 * Uses localStorage for simplicity in Electron renderer process
 */

const STORAGE_KEYS = {
  AUTH_TOKEN: 'kurisu_auth_token',
  REMEMBER_ME: 'kurisu_remember_me',
  SELECTED_MODEL: 'kurisu_selected_model',
  TTS_VOICE: 'kurisu_tts_voice',
  TTS_LANGUAGE: 'kurisu_tts_language',
  TTS_AUTO_PLAY: 'kurisu_tts_auto_play',
  TTS_BACKEND: 'kurisu_tts_backend',
  BACKEND_URL: 'kurisu_backend_url',
  SHOW_ADMINISTRATOR: 'kurisu_show_administrator',
  ASR_DEVICE_ID: 'kurisu_asr_device_id',
  SELECTED_AGENT_ID: 'kurisu_selected_agent_id',
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
      return localStorage.getItem(STORAGE_KEYS.TTS_AUTO_PLAY) === 'true';
    } catch (error) {
      console.error('Failed to get TTS auto-play preference:', error);
      return false;
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
   * Get TTS backend from persistent storage
   */
  getTTSBackend(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.TTS_BACKEND);
    } catch (error) {
      console.error('Failed to get TTS backend:', error);
      return null;
    }
  },

  /**
   * Save INDEX-TTS emotion settings to persistent storage
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

  /**
   * Save show Administrator messages preference (default: false/hidden)
   */
  setShowAdministrator(show: boolean): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SHOW_ADMINISTRATOR, show.toString());
    } catch (error) {
      console.error('Failed to save show Administrator preference:', error);
    }
  },

  /**
   * Get show Administrator messages preference (default: false/hidden)
   */
  getShowAdministrator(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEYS.SHOW_ADMINISTRATOR) === 'true';
    } catch (error) {
      console.error('Failed to get show Administrator preference:', error);
      return false; // Default: hide Administrator messages
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
};
