import { create } from 'zustand';

export type ActivePage = 'workspace' | 'conversations' | 'settings';

interface LayoutState {
  activePage: ActivePage;
  chatPanelWidth: number;
  settingsSection: string;
  workspaceTreeWidth: number;
  /** The inline character panel shows in the chat column (#241). */
  characterVisible: boolean;
  /** Its height in px; the panel's CSS keeps it between the bounds below. */
  characterPanelHeight: number;
  setActivePage: (page: ActivePage) => void;
  setChatPanelWidth: (width: number) => void;
  setSettingsSection: (section: string) => void;
  setWorkspaceTreeWidth: (width: number) => void;
  /** Persisted at once: a toggle is not a drag with an end. */
  setCharacterVisible: (visible: boolean) => void;
  setCharacterPanelHeight: (height: number) => void;
  persistWidths: () => void;
}

const CHAT_PANEL_WIDTH_KEY = 'kurisu_chat_panel_width';
const WORKSPACE_TREE_WIDTH_KEY = 'kurisu_workspace_tree_width';
const CHARACTER_VISIBLE_KEY = 'kurisu_character_visible';
const CHARACTER_PANEL_HEIGHT_KEY = 'kurisu_character_panel_height';

export const CHARACTER_PANEL_DEFAULT_HEIGHT = 320;
export const CHARACTER_PANEL_MIN_HEIGHT = 160;
/** Of the chat column, so the composer below it always stays on screen. */
export const CHARACTER_PANEL_MAX_FRACTION = 0.6;

function loadNumber(key: string, fallback: number): number {
  try {
    const val = localStorage.getItem(key);
    const n = val ? Number(val) : NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the layout still works, it just is not remembered.
  }
}

function loadBoolean(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  activePage: 'workspace',
  chatPanelWidth: loadNumber(CHAT_PANEL_WIDTH_KEY, 400),
  settingsSection: 'account',
  workspaceTreeWidth: loadNumber(WORKSPACE_TREE_WIDTH_KEY, 240),
  characterVisible: loadBoolean(CHARACTER_VISIBLE_KEY),
  characterPanelHeight: loadNumber(CHARACTER_PANEL_HEIGHT_KEY, CHARACTER_PANEL_DEFAULT_HEIGHT),

  setActivePage: (page) => set({ activePage: page }),

  setChatPanelWidth: (width) => set({ chatPanelWidth: width }),

  setSettingsSection: (section) => set({ settingsSection: section }),

  setWorkspaceTreeWidth: (width) => set({ workspaceTreeWidth: width }),

  setCharacterVisible: (visible) => {
    set({ characterVisible: visible });
    save(CHARACTER_VISIBLE_KEY, String(visible));
  },

  setCharacterPanelHeight: (height) => set({ characterPanelHeight: height }),

  // Call once after drag ends to persist to localStorage
  persistWidths: () => {
    const { chatPanelWidth, workspaceTreeWidth, characterPanelHeight } = get();
    save(CHAT_PANEL_WIDTH_KEY, String(chatPanelWidth));
    save(WORKSPACE_TREE_WIDTH_KEY, String(workspaceTreeWidth));
    save(CHARACTER_PANEL_HEIGHT_KEY, String(characterPanelHeight));
  },
}));
