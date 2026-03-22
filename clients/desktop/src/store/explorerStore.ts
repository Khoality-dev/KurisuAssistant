import { create } from 'zustand';

export interface FileEntry {
  name: string;
  fullPath: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  extension: string;
}

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
  currentPath: string;
  entries: FileEntry[];
  isLoading: boolean;
  isRoot: boolean;
  openFiles: OpenFile[];
  activeFileIndex: number;
  viewMode: ExplorerViewMode;
  workspaceRoot: string; // folder shown in tree sidebar during editor mode
  navigate: (path: string) => Promise<void>;
  openFile: (entry: FileEntry) => Promise<void>;
  forceOpenBinary: (index: number) => Promise<void>;
  closeFile: (index: number) => void;
  setActiveFile: (index: number) => void;
  updateFileContent: (index: number, content: string) => void;
  saveFile: (index: number) => Promise<void>;
  setViewMode: (mode: ExplorerViewMode) => void;
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
  currentPath: '',
  entries: [],
  isLoading: false,
  isRoot: true,
  openFiles: [],
  activeFileIndex: -1,
  viewMode: (localStorage.getItem('kurisu_explorer_view') as ExplorerViewMode) || 'list',
  workspaceRoot: '',

  navigate: async (navPath: string) => {
    set({ isLoading: true });
    try {
      const result = await window.electron.explorer.listDirectory(navPath);
      set({
        currentPath: result.path,
        entries: result.entries,
        isRoot: result.isRoot,
        isLoading: false,
      });
    } catch (err) {
      console.error('Failed to navigate:', err);
      set({ isLoading: false });
    }
  },

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
      const binary = window.electron.explorer.isBinary
        ? await window.electron.explorer.isBinary(entry.fullPath)
        : false;

      let content = '';
      let error: string | undefined;
      if (!binary) {
        const result = await window.electron.explorer.readFile(entry.fullPath);
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

      // Set workspace root to file's parent dir (or current browsed path)
      const parentDir = entry.fullPath.replace(/[\\/][^\\/]+$/, '');
      const { currentPath, workspaceRoot } = get();
      const newRoot = workspaceRoot || currentPath || parentDir;

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
      const result = await window.electron.explorer.readFile(file.path);
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
    set({ activeFileIndex: index });
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
      const result = await window.electron.explorer.writeFile(file.path, file.content);
      if (result.error) {
        console.error('Failed to save file:', result.error);
        return;
      }

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
}));
