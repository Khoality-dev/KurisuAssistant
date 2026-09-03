import { create } from 'zustand';
import { apiClient } from '../api/client';

/**
 * Tool permission policies - synced to backend.
 * Each tool can be "allow" (auto-approve) or "deny" (auto-reject).
 * If not set, the tool will show an approval dialog.
 */
interface ToolPermissionPolicy {
  tools: Record<string, 'allow' | 'deny'>;
}

interface ToolPermissionsState {
  // Permanent policies (synced to backend)
  policy: ToolPermissionPolicy;

  // Session approvals (cleared on page refresh/reconnect)
  sessionApprovals: Set<string>;

  // Loading state
  isLoading: boolean;

  // Actions
  loadPolicies: () => Promise<void>;
  setToolPolicy: (toolName: string, policy: 'allow' | 'deny') => Promise<void>;
  removeToolPolicy: (toolName: string) => Promise<void>;
  clearAllPolicies: () => Promise<void>;

  // Session-only approvals
  addSessionApproval: (toolName: string) => void;
  hasSessionApproval: (toolName: string) => boolean;
  clearSessionApprovals: () => void;

  // Check if a tool should be auto-approved/denied
  getToolDecision: (toolName: string) => 'allow' | 'deny' | 'ask';
}

export const useToolPermissionsStore = create<ToolPermissionsState>((set, get) => ({
  policy: { tools: {} },
  sessionApprovals: new Set<string>(),
  isLoading: false,

  loadPolicies: async () => {
    set({ isLoading: true });
    try {
      const policies = await apiClient.getToolPolicies();
      set({ policy: policies, isLoading: false });
    } catch (error) {
      console.error('Failed to load tool policies:', error);
      set({ isLoading: false });
    }
  },

  setToolPolicy: async (toolName: string, policy: 'allow' | 'deny') => {
    const current = get().policy;
    const newTools = { ...current.tools, [toolName]: policy };

    // Optimistic update
    set({ policy: { tools: newTools } });

    try {
      await apiClient.patchToolPolicy(toolName, policy);
    } catch (error) {
      // Revert on failure
      console.error('Failed to set tool policy:', error);
      set({ policy: current });
    }
  },

  removeToolPolicy: async (toolName: string) => {
    const current = get().policy;
    const newTools = { ...current.tools };
    delete newTools[toolName];

    // Optimistic update
    set({ policy: { tools: newTools } });

    try {
      await apiClient.patchToolPolicy(toolName, null);
    } catch (error) {
      // Revert on failure
      console.error('Failed to remove tool policy:', error);
      set({ policy: current });
    }
  },

  clearAllPolicies: async () => {
    const current = get().policy;

    // Optimistic update
    set({ policy: { tools: {} } });

    try {
      await apiClient.updateToolPolicies({ tools: {} });
    } catch (error) {
      // Revert on failure
      console.error('Failed to clear tool policies:', error);
      set({ policy: current });
    }
  },

  addSessionApproval: (toolName: string) => {
    const newSet = new Set(get().sessionApprovals);
    newSet.add(toolName);
    set({ sessionApprovals: newSet });
  },

  hasSessionApproval: (toolName: string) => {
    return get().sessionApprovals.has(toolName);
  },

  clearSessionApprovals: () => {
    set({ sessionApprovals: new Set() });
  },

  getToolDecision: (toolName: string) => {
    // Check session approvals first
    if (get().sessionApprovals.has(toolName)) {
      return 'allow';
    }

    // Check permanent policy
    const policy = get().policy.tools[toolName];
    if (policy) {
      return policy;
    }

    // No policy set - show dialog
    return 'ask';
  },
}));
