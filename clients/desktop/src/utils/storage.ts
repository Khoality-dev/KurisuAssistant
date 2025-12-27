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
};
