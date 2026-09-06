import type { FileEntry } from '@kurisu/models';
import { create } from 'zustand';
import { dirnameOf, fileSource } from '../api/fileSource';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  language: string;
  isBinary: boolean;
  forceOpen: boolean;
  error?: string; // read error message
}

export type ExplorerViewMode = 'list' | 'grid';

interface ExplorerState {
  // Browsing state lives in `FullExplorer`, which is the only thing that
  // renders it. This store owns the editor: open files, tabs, selections.
  openFiles: OpenFile[];
  activeFileIndex: number;
  viewMode: ExplorerViewMode;
  workspaceRoot: string;
  // Pinned selections — added explicitly via Ctrl+Shift+L or right-click
  selections: Array<{
    id: string;
    filePath: string;
    fileName: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    text: string;
  }>;
  // Live selections — auto-set from explorer/editor, replaced on each interaction
  liveSelections: Array<{
    filePath: string;
    fileName: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    isWholeFile: boolean;
  }>;
  openFile: (entry: FileEntry) => Promise<void>;
  forceOpenBinary: (index: number) => Promise<void>;
  closeFile: (index: number) => void;
  setActiveFile: (index: number) => void;
  updateFileContent: (index: number, content: string) => void;
  saveFile: (index: number) => Promise<void>;
  /** Why the last save failed, for whoever is showing the editor. */
  saveError: string | null;
  clearSaveError: () => void;
  setViewMode: (mode: ExplorerViewMode) => void;
  revealSelection: ExplorerState['selections'][number] | null;
  diffReview: {
    reviewId: string;
    filePath: string;
    fileName: string;
    originalContent: string;
    modifiedContent: string;
  } | null;
  addSelection: (selection: Omit<ExplorerState['selections'][number], 'id'>) => void;
  removeSelection: (id: string) => void;
  setLiveSelections: (sels: ExplorerState['liveSelections']) => void;
  clearAllSelections: () => void;
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.bat': 'bat',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.r': 'r',
};

function getLanguageFromExtension(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';

  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return 'plaintext';
  const ext = lower.slice(dotIdx);
  return EXTENSION_LANGUAGE_MAP[ext] || 'plaintext';
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
export function isImageFile(filename: string): boolean {
  const dotIdx = filename.toLowerCase().lastIndexOf('.');
  if (dotIdx === -1) return false;
  return IMAGE_EXTENSIONS.has(filename.toLowerCase().slice(dotIdx));
}


export const useExplorerStore = create<ExplorerState>((set, get) => ({
  openFiles: [],
  activeFileIndex: -1,
  viewMode: (localStorage.getItem('kurisu_explorer_view') as ExplorerViewMode) || 'list',
  workspaceRoot: '',
  selections: [],
  liveSelections: [],
  revealSelection: null,
  diffReview: null,
  saveError: null,

  openFile: async (entry: FileEntry) => {
    const { openFiles } = get();

    // If already open, just switch to it
    const existingIndex = openFiles.findIndex((f) => f.path === entry.fullPath);
    if (existingIndex !== -1) {
      set({ activeFileIndex: existingIndex });
      return;
    }

    try {
      // Check binary via raw buffer in main process (not utf-8 which corrupts binary)
      const binary = await fileSource.isBinary(entry.fullPath);

      let content = '';
      let error: string | undefined;
      if (!binary) {
        const result = await fileSource.readFile(entry.fullPath);
        if (result.error) {
          error = result.error;
        } else {
          content = result.content ?? '';
        }
      }

      const newFile: OpenFile = {
        path: entry.fullPath,
        name: entry.name,
        content,
        originalContent: content,
        language: getLanguageFromExtension(entry.name),
        isBinary: binary,
        forceOpen: false,
        error,
      };

      // Set workspace root to the file's parent folder. `dirnameOf` picks the
      // separator from the path, so a drive path keeps its POSIX shape on
      // Windows.
      const { workspaceRoot } = get();
      const newRoot = workspaceRoot || dirnameOf(entry.fullPath);

      set({
        openFiles: [...openFiles, newFile],
        activeFileIndex: openFiles.length,
        workspaceRoot: newRoot,
      });
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  },

  forceOpenBinary: async (index: number) => {
    const { openFiles } = get();
    const file = openFiles[index];
    if (!file) return;

    try {
      const result = await fileSource.readFile(file.path);
      if (result.error) return;

      const content = result.content ?? '';
      const updated = [...openFiles];
      updated[index] = { ...updated[index], content, originalContent: content, forceOpen: true };
      set({ openFiles: updated });
    } catch (err) {
      console.error('Failed to force open binary:', err);
    }
  },

  closeFile: (index: number) => {
    const { openFiles, activeFileIndex } = get();
    const newFiles = openFiles.filter((_, i) => i !== index);
    let newActive = activeFileIndex;

    if (newFiles.length === 0) {
      newActive = -1;
      set({ openFiles: newFiles, activeFileIndex: newActive, workspaceRoot: '' });
      return;
    } else if (index === activeFileIndex) {
      newActive = Math.min(index, newFiles.length - 1);
    } else if (index < activeFileIndex) {
      newActive = activeFileIndex - 1;
    }

    set({ openFiles: newFiles, activeFileIndex: newActive });
  },

  setActiveFile: (index: number) => {
    const { openFiles } = get();
    const file = openFiles[index];
    set({
      activeFileIndex: index,
      liveSelections: file ? [{
        filePath: file.path,
        fileName: file.name,
        startLine: 1,
        endLine: 0,
        startColumn: 0,
        endColumn: 0,
        isWholeFile: true,
      }] : [],
    });
  },

  updateFileContent: (index: number, content: string) => {
    const { openFiles } = get();
    const updated = [...openFiles];
    updated[index] = { ...updated[index], content };
    set({ openFiles: updated });
  },

  saveFile: async (index: number) => {
    const { openFiles } = get();
    const file = openFiles[index];
    if (!file) return;

    try {
      const result = await fileSource.writeFile(file.path, file.content);
      if (result.error) {
        // A drive save is refused for reasons the user can act on — the drive is
        // full, the file is gone, they are signed out — and a console line is
        // not telling them. Without this the tab looks saved and the edits go
        // when it is closed.
        set({ saveError: result.error });
        return;
      }
      set({ saveError: null });

      const updated = [...openFiles];
      updated[index] = { ...updated[index], originalContent: file.content };
      set({ openFiles: updated });
    } catch (err) {
      console.error('Failed to save file:', err);
    }
  },

  setViewMode: (mode) => {
    localStorage.setItem('kurisu_explorer_view', mode);
    set({ viewMode: mode });
  },

  addSelection: (selection) => {
    const id = `${selection.filePath}:${selection.startLine}:${selection.endLine}`;
    const { selections } = get();
    // Don't add duplicate
    if (selections.some(s => s.id === id)) return;
    set({ selections: [...selections, { ...selection, id }] });
  },
  removeSelection: (id) => {
    set({ selections: get().selections.filter(s => s.id !== id) });
  },
  clearSaveError: () => set({ saveError: null }),
  setLiveSelections: (sels) => set({ liveSelections: sels }),
  clearAllSelections: () => set({ selections: [], liveSelections: [] }),
}));
