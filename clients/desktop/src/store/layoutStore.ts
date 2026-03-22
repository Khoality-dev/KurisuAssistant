import { create } from 'zustand';

export type ActivePage = 'explorer' | 'conversations' | 'settings';

interface LayoutState {
  activePage: ActivePage;
  chatPanelWidth: number;
  settingsSection: string;
  explorerTreeWidth: number;
  setActivePage: (page: ActivePage) => void;
  setChatPanelWidth: (width: number) => void;
  setSettingsSection: (section: string) => void;
  setExplorerTreeWidth: (width: number) => void;
}

const CHAT_PANEL_WIDTH_KEY = 'kurisu_chat_panel_width';
const EXPLORER_TREE_WIDTH_KEY = 'kurisu_explorer_tree_width';

function loadNumber(key: string, fallback: number): number {
  try {
    const val = localStorage.getItem(key);
    return val ? Number(val) : fallback;
  } catch {
    return fallback;
  }
}

export const useLayoutStore = create<LayoutState>((set) => ({
  activePage: 'explorer',
  chatPanelWidth: loadNumber(CHAT_PANEL_WIDTH_KEY, 400),
  settingsSection: 'account',
  explorerTreeWidth: loadNumber(EXPLORER_TREE_WIDTH_KEY, 240),

  setActivePage: (page) => set({ activePage: page }),

  setChatPanelWidth: (width) => {
    localStorage.setItem(CHAT_PANEL_WIDTH_KEY, String(width));
    set({ chatPanelWidth: width });
  },

  setSettingsSection: (section) => set({ settingsSection: section }),

  setExplorerTreeWidth: (width) => {
    localStorage.setItem(EXPLORER_TREE_WIDTH_KEY, String(width));
    set({ explorerTreeWidth: width });
  },
}));
