import { create } from 'zustand';
import { apiClient } from '../api/client';
import { forgetDriveCache } from '../api/fileSource';
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

    // The window holds the tokens either way — the authed asset URLs read them
    // from here, and with remember-me off they used to come back null. What the
    // preference decides is whether they reach the keychain, which
    // `storage.setToken` checks; so it is set first.
    storage.setRememberMe(rememberMe);
    storage.setToken(response.access_token);
    storage.setRefreshToken(response.refresh_token);

    const user = await apiClient.getUserProfile();
    set({ isAuthenticated: true, user, rememberMe });
    // Load tool permission policies
    useToolPermissionsStore.getState().loadPolicies();
  },

  register: async (username: string, password: string, email?: string, rememberMe: boolean = false) => {
    const response = await apiClient.register(username, password, email);

    // The window holds the tokens either way — the authed asset URLs read them
    // from here, and with remember-me off they used to come back null. What the
    // preference decides is whether they reach the keychain, which
    // `storage.setToken` checks; so it is set first.
    storage.setRememberMe(rememberMe);
    storage.setToken(response.access_token);
    storage.setRefreshToken(response.refresh_token);

    const user = await apiClient.getUserProfile();
    set({ isAuthenticated: true, user, rememberMe });
    // Load tool permission policies
    useToolPermissionsStore.getState().loadPolicies();
  },

  logout: () => {
    apiClient.clearToken();
    storage.clearTokens();
    // Node ids are per account. Keeping the map across a sign-out would
    // point the next account's paths at the previous one's rows.
    forgetDriveCache();
    storage.setRememberMe(false);
    storage.clearAllPersonaConversations();
    set({ isAuthenticated: false, user: null, rememberMe: false });
  },

  loadUserProfile: async () => {
    const user = await apiClient.getUserProfile();
    set({ user });
  },

  initializeAuth: async () => {
    // Drop the pre-split cache keys once per launch. Both were caches that
    // re-derive from the backend, so there is nothing to migrate.
    storage.clearLegacyAgentKeys();

    // Tokens live in the OS keychain, so they have to be fetched before any
    // read of them. This also migrates a pair left in localStorage by an
    // older build.
    await storage.loadPersistedTokens();

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
      storage.clearTokens();
      storage.setRememberMe(false);
      apiClient.clearToken();
      set({ isAuthenticated: false, user: null, rememberMe: false });
    }
  },

  setRememberMe: (remember: boolean) => {
    set({ rememberMe: remember });
  },
}));
