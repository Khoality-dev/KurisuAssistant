/**
 * Persistent storage utility for auth tokens
 * Uses localStorage for simplicity in Electron renderer process
 */

const STORAGE_KEYS = {
  AUTH_TOKEN: 'kurisu_auth_token',
  REMEMBER_ME: 'kurisu_remember_me',
  SELECTED_MODEL: 'kurisu_selected_model',
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
};
