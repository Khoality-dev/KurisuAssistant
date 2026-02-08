import { create } from 'zustand';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import type { UserProfile } from '../api/types';

interface AuthState {
  isAuthenticated: boolean;
  user: UserProfile | null;
  rememberMe: boolean;
  login: (username: string, password: string, rememberMe: boolean) => Promise<void>;
  register: (username: string, password: string, email?: string, rememberMe?: boolean) => Promise<void>;
  logout: () => void;
  loadUserProfile: () => Promise<void>;
  initializeAuth: () => Promise<void>;
  setRememberMe: (remember: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  user: null,
  rememberMe: storage.getRememberMe(),

  login: async (username: string, password: string, rememberMe: boolean) => {
    const response = await apiClient.login(username, password);

    // Save token to storage if remember me is enabled
    if (rememberMe) {
      storage.setToken(response.access_token);
      storage.setRememberMe(true);
    } else {
      storage.clearToken();
      storage.setRememberMe(false);
    }

    const user = await apiClient.getUserProfile();
    set({ isAuthenticated: true, user, rememberMe });
  },

  register: async (username: string, password: string, email?: string, rememberMe: boolean = false) => {
    const response = await apiClient.register(username, password, email);

    // Save token to storage if remember me is enabled
    if (rememberMe) {
      storage.setToken(response.access_token);
      storage.setRememberMe(true);
    } else {
      storage.clearToken();
      storage.setRememberMe(false);
    }

    const user = await apiClient.getUserProfile();
    set({ isAuthenticated: true, user, rememberMe });
  },

  logout: () => {
    apiClient.clearToken();
    storage.clearToken();
    storage.setRememberMe(false);
    set({ isAuthenticated: false, user: null, rememberMe: false });
  },

  loadUserProfile: async () => {
    const user = await apiClient.getUserProfile();
    set({ user });
  },

  initializeAuth: async () => {
    const token = storage.getToken();
    const rememberMe = storage.getRememberMe();

    if (token && rememberMe) {
      try {
        // Set token in API client
        apiClient.setToken(token);

        // Verify token is still valid by fetching user profile
        const user = await apiClient.getUserProfile();
        set({ isAuthenticated: true, user, rememberMe });
      } catch (error) {
        // Token is invalid or expired, clear it
        console.error('Stored token is invalid:', error);
        storage.clearToken();
        storage.setRememberMe(false);
        apiClient.clearToken();
        set({ isAuthenticated: false, user: null, rememberMe: false });
      }
    }
  },

  setRememberMe: (remember: boolean) => {
    set({ rememberMe: remember });
  },
}));
