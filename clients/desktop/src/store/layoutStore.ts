import { create } from 'zustand';

export type ActivePage = 'workspace' | 'conversations' | 'settings';

interface LayoutState {
  activePage: ActivePage;
  chatPanelWidth: number;
  settingsSection: string;
  workspaceTreeWidth: number;
  setActivePage: (page: ActivePage) => void;
  setChatPanelWidth: (width: number) => void;
  setSettingsSection: (section: string) => void;
  setWorkspaceTreeWidth: (width: number) => void;
}

const CHAT_PANEL_WIDTH_KEY = 'kurisu_chat_panel_width';
const WORKSPACE_TREE_WIDTH_KEY = 'kurisu_workspace_tree_width';

function loadNumber(key: string, fallback: number): number {
  try {
    const val = localStorage.getItem(key);
    return val ? Number(val) : fallback;
  } catch {
    return fallback;
  }
}

export const useLayoutStore = create<LayoutState>((set) => ({
  activePage: 'workspace',
  chatPanelWidth: loadNumber(CHAT_PANEL_WIDTH_KEY, 400),
  settingsSection: 'account',
  workspaceTreeWidth: loadNumber(WORKSPACE_TREE_WIDTH_KEY, 240),

  setActivePage: (page) => set({ activePage: page }),

  setChatPanelWidth: (width) => {
    localStorage.setItem(CHAT_PANEL_WIDTH_KEY, String(width));
    set({ chatPanelWidth: width });
  },

  setSettingsSection: (section) => set({ settingsSection: section }),

  setWorkspaceTreeWidth: (width) => {
    localStorage.setItem(WORKSPACE_TREE_WIDTH_KEY, String(width));
    set({ workspaceTreeWidth: width });
  },
}));
