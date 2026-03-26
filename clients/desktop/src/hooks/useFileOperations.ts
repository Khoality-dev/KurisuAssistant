/**
 * Custom hook for file operations in the explorer.
 * Manages clipboard, rename, create, delete, copy, cut, paste operations
 * and keyboard shortcuts that drive them.
 */

import { useCallback, useEffect, useState } from 'react';
import { useExplorerStore, type FileEntry } from '../store/explorerStore';

const OPERATING_SYSTEM = window.electron?.platform ?? 'win32';
const SEP = OPERATING_SYSTEM === 'win32' ? '\\' : '/';

/** Join path segments, handling trailing separators and normalizing slashes. */
function joinPath(base: string, ...parts: string[]): string {
  let result = base;
  for (const part of parts) {
    if (!result.endsWith(SEP) && !result.endsWith('/')) result += SEP;
    result += part;
  }
  // Normalize doubled separators (but preserve leading \\ for UNC paths)
  return result.replace(/(?<!^)[\\/]{2,}/g, SEP);
}

interface UseFileOperationsParams {
  currentPath: string;
  entries: FileEntry[];
  selectedEntries: Set<string>;
  setSelectedEntries: React.Dispatch<React.SetStateAction<Set<string>>>;
  loadEntries: (path: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
}

export function useFileOperations({
  currentPath,
  entries,
  selectedEntries,
  setSelectedEntries,
  loadEntries,
  searchInputRef,
}: UseFileOperationsParams) {
  const { addSelection } = useExplorerStore();

  const [clipboard, setClipboard] = useState<{ path: string; name: string; cut: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'folder' | null>(null);

  const handleRename = useCallback(async () => {
    if (!renaming || !renameValue.trim() || renameValue === renaming.name) {
      setRenaming(null);
      return;
    }
    const dir = renaming.path.replace(/[\\/][^\\/]+$/, '');
    const newPath = joinPath(dir, renameValue.trim());
    const result = await window.electron?.explorer?.rename(renaming.path, newPath);
    if (result?.error) console.error('Rename failed:', result.error);
    setRenaming(null);
    loadEntries(currentPath);
  }, [renaming, renameValue, currentPath, loadEntries]);

  const handleDelete = useCallback(async (targetPath?: string) => {
    const paths = targetPath ? [targetPath] : entries.filter(e => selectedEntries.has(e.fullPath)).map(e => e.fullPath);
    if (paths.length === 0) return;
    for (const p of paths) {
      await window.electron?.explorer?.delete(p);
    }
    setSelectedEntries(new Set());
    loadEntries(currentPath);
  }, [entries, selectedEntries, setSelectedEntries, currentPath, loadEntries]);

  const handleCopy = useCallback((path: string, name: string) => {
    setClipboard({ path, name, cut: false });
  }, []);

  const handleCut = useCallback((path: string, name: string) => {
    setClipboard({ path, name, cut: true });
  }, []);

  const handlePaste = useCallback(async () => {
    if (!clipboard || !currentPath) return;
    const dest = joinPath(currentPath, clipboard.name);
    if (clipboard.cut) {
      await window.electron?.explorer?.rename(clipboard.path, dest);
      setClipboard(null);
    } else {
      await window.electron?.explorer?.copy(clipboard.path, dest);
    }
    loadEntries(currentPath);
  }, [clipboard, currentPath, loadEntries]);

  const handleCreateFile = useCallback(async () => {
    if (!newItemName.trim() || !currentPath) return;
    const filePath = joinPath(currentPath, newItemName.trim());
    await window.electron?.explorer?.createFile(filePath);
    setNewItemType(null);
    setNewItemName('');
    loadEntries(currentPath);
  }, [newItemName, currentPath, loadEntries]);

  const handleCreateFolder = useCallback(async () => {
    if (!newItemName.trim() || !currentPath) return;
    const dirPath = joinPath(currentPath, newItemName.trim());
    await window.electron?.explorer?.createFolder(dirPath);
    setNewItemType(null);
    setNewItemName('');
    loadEntries(currentPath);
  }, [newItemName, currentPath, loadEntries]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F: focus search bar
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        setSelectedEntries(new Set(entries.map(en => en.fullPath)));
      } else if (e.key === 'F2') {
        // Rename selected
        const sel = entries.find(en => selectedEntries.has(en.fullPath));
        if (sel) {
          setRenaming({ path: sel.fullPath, name: sel.name });
          setRenameValue(sel.name);
        }
      } else if (e.key === 'Delete') {
        if (selectedEntries.size > 0) handleDelete();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const sel = entries.find(en => selectedEntries.has(en.fullPath));
        if (sel) handleCopy(sel.fullPath, sel.name);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        const sel = entries.find(en => selectedEntries.has(en.fullPath));
        if (sel) handleCut(sel.fullPath, sel.name);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        handlePaste();
      } else if (e.key === 'F3') {
        // Add selected to chat
        const selected = entries.filter(en => selectedEntries.has(en.fullPath));
        for (const entry of selected) {
          addSelection({
            filePath: entry.fullPath, fileName: entry.name,
            startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, text: '',
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [entries, selectedEntries, clipboard, currentPath, handleDelete, handleCopy, handleCut, handlePaste, addSelection, setSelectedEntries, searchInputRef]);

  return {
    clipboard,
    setClipboard,
    renaming,
    setRenaming,
    renameValue,
    setRenameValue,
    newItemName,
    setNewItemName,
    newItemType,
    setNewItemType,
    handleRename,
    handleDelete,
    handleCopy,
    handleCut,
    handlePaste,
    handleCreateFile,
    handleCreateFolder,
  };
}
