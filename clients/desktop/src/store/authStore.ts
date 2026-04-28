import { create } from 'zustand';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import { useToolPermissionsStore } from './toolPermissionsStore';
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

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  user: null,
  rememberMe: storage.getRememberMe(),

  login: async (username: string, password: string, rememberMe: boolean) => {
    const response = await apiClient.login(username, password);

    if (rememberMe) {
      storage.setToken(response.access_token);
      storage.setRefreshToken(response.refresh_token);
      storage.setRememberMe(true);
    } else {
      storage.clearToken();
      storage.clearRefreshToken();
      storage.setRememberMe(false);
    }

    const user = await apiClient.getUserProfile();
    set({ isAuthenticated: true, user, rememberMe });
    // Load tool permission policies
    useToolPermissionsStore.getState().loadPolicies();
  },

  register: async (username: string, password: string, email?: string, rememberMe: boolean = false) => {
    const response = await apiClient.register(username, password, email);

    if (rememberMe) {
      storage.setToken(response.access_token);
      storage.setRefreshToken(response.refresh_token);
      storage.setRememberMe(true);
    } else {
      storage.clearToken();
      storage.clearRefreshToken();
      storage.setRememberMe(false);
    }

    const user = await apiClient.getUserProfile();
    set({ isAuthenticated: true, user, rememberMe });
    // Load tool permission policies
    useToolPermissionsStore.getState().loadPolicies();
  },

  logout: () => {
    apiClient.clearToken();
    storage.clearToken();
    storage.clearRefreshToken();
    storage.setRememberMe(false);
    storage.clearAllAgentConversations();
    set({ isAuthenticated: false, user: null, rememberMe: false });
  },

  loadUserProfile: async () => {
    const user = await apiClient.getUserProfile();
    set({ user });
  },

  initializeAuth: async () => {
    const token = storage.getToken();
    const refreshToken = storage.getRefreshToken();
    const rememberMe = storage.getRememberMe();

    // Wire up auth failure callback so 401s trigger logout
    apiClient.onAuthFailure(() => {
      get().logout();
    });

    if (!rememberMe || (!token && !refreshToken)) return;

    // Set refresh token first so auto-refresh can work
    if (refreshToken) {
      apiClient.setRefreshToken(refreshToken);
    }

    if (token) {
      apiClient.setToken(token);
    }

    try {
      // getUserProfile will auto-refresh via the 401 interceptor if token expired
      const user = await apiClient.getUserProfile();
      set({ isAuthenticated: true, user, rememberMe });
      // Load tool permission policies
      useToolPermissionsStore.getState().loadPolicies();
    } catch {
      // Both tokens are invalid — clear everything
      storage.clearToken();
      storage.clearRefreshToken();
      storage.setRememberMe(false);
      apiClient.clearToken();
      set({ isAuthenticated: false, user: null, rememberMe: false });
    }
  },

  setRememberMe: (remember: boolean) => {
    set({ rememberMe: remember });
  },
}));
