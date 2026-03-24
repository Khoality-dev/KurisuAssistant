/**
 * Full-page file explorer — shown when no files are open in the editor.
 * Displays a browseable file/folder list with breadcrumb navigation.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Breadcrumbs,
  Link,
  CircularProgress,
  IconButton,
  Tooltip,
  Menu,
  MenuItem,
  ListItemText,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from '@mui/material';
import {
  ArrowUpward as UpIcon,
  Home as HomeIcon,
  ViewList as ListViewIcon,
  GridView as GridViewIcon,
  Search as SearchIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import InputAdornment from '@mui/material/InputAdornment';
import { getFileIcon } from './FileIcon';
import { useExplorerStore, type FileEntry } from '../../store/explorerStore';

const OPERATING_SYSTEM = window.electron?.platform ?? 'win32';
const SEP = OPERATING_SYSTEM === 'win32' ? '\\' : '/';

/** Render text with query matches highlighted. */
const Highlight: React.FC<{ text: string; query: string; caseSensitive?: boolean }> = ({ text, query, caseSensitive = false }) => {
  if (!query) return <span>{text}</span>;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = haystack.indexOf(needle, cursor);
  while (idx !== -1) {
    if (idx > cursor) parts.push(text.substring(cursor, idx));
    parts.push(
      <span key={idx} style={{ backgroundColor: 'rgba(255,213,79,0.4)', borderRadius: 2, padding: '0 1px' }}>
        {text.substring(idx, idx + query.length)}
      </span>
    );
    cursor = idx + query.length;
    idx = haystack.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.substring(cursor));
  return <span>{parts}</span>;
};

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

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const FullExplorer: React.FC = () => {
  const { openFile, viewMode, setViewMode, addSelection, setLiveSelections } = useExplorerStore();

  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [lasso, setLasso] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const lassoStart = useRef<{ x: number; y: number; scrollX: number; scrollY: number } | null>(null);
  const lassoDragged = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasVSCode, setHasVSCode] = useState(false);
  const [clipboard, setClipboard] = useState<{ path: string; name: string; cut: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'folder' | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [filterText, setFilterText] = useState('');
  const [searchResults, setSearchResults] = useState<{
    names: Array<{ path: string; name: string; type: 'file' | 'directory' }>;
    matches: Array<{ path: string; line: number; snippet: string }>;
  } | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentCleanupRef = useRef<Array<() => void>>([]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; entry: FileEntry } | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ mouseX: number; mouseY: number } | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRoot, setIsRoot] = useState(true);

  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!window.electron?.explorer) return;
    setIsLoading(true);
    setSelectedEntries(new Set());
    setFilterText('');
    setSearchResults(null);
    window.electron?.explorer?.searchContentCancel?.();
    contentCleanupRef.current.forEach((fn) => fn());
    contentCleanupRef.current = [];
    try {
      const result = await window.electron.explorer.listDirectory(dirPath);
      setCurrentPath(result.path);
      setEntries(result.entries);
      setIsRoot(result.isRoot);
    } catch {
      setEntries([]);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    loadDirectory('');
  }, [loadDirectory]);

  // Sync selected entries → live selection chips
  useEffect(() => {
    if (selectedEntries.size === 0) {
      setLiveSelections([]);
      return;
    }
    const sels = entries
      .filter(e => selectedEntries.has(e.fullPath))
      .map(e => ({
        filePath: e.fullPath,
        fileName: e.name,
        startLine: 0,
        endLine: 0,
        isWholeFile: true,
      }));
    setLiveSelections(sels);
  }, [selectedEntries, entries, setLiveSelections]);

  // Check if VS Code is available
  useEffect(() => {
    window.electron?.explorer?.hasVSCode?.().then(setHasVSCode).catch(() => {});
  }, []);

  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY, entry });
  };

  const handleCloseContextMenu = () => setContextMenu(null);

  const handleOpenInVSCode = () => {
    if (contextMenu) {
      window.electron?.explorer?.openInVSCode(contextMenu.entry.fullPath);
      setContextMenu(null);
    }
  };

  const lastClickedRef = useRef<string | null>(null);

  // Single click: select (Ctrl toggle, Shift range). Double click: open.
  const handleEntryClick = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.ctrlKey || e.metaKey) {
      // Toggle selection
      setSelectedEntries((prev) => {
        const next = new Set(prev);
        if (next.has(entry.fullPath)) next.delete(entry.fullPath);
        else next.add(entry.fullPath);
        return next;
      });
    } else if (e.shiftKey) {
      // Add to selection
      setSelectedEntries((prev) => {
        const next = new Set(prev);
        next.add(entry.fullPath);
        return next;
      });
    } else {
      setSelectedEntries(new Set([entry.fullPath]));
    }
    lastClickedRef.current = entry.fullPath;
  };

  const handleEntryDoubleClick = (entry: FileEntry) => {
    if (entry.type === 'directory') {
      loadDirectory(entry.fullPath);
      setSelectedEntries(new Set());
    } else {
      openFile(entry);
    }
  };

  // File operation handlers
  const handleRename = async () => {
    if (!renaming || !renameValue.trim() || renameValue === renaming.name) {
      setRenaming(null);
      return;
    }
    const dir = renaming.path.replace(/[\\/][^\\/]+$/, '');
    const newPath = joinPath(dir, renameValue.trim());
    const result = await window.electron?.explorer?.rename(renaming.path, newPath);
    if (result?.error) console.error('Rename failed:', result.error);
    setRenaming(null);
    loadDirectory(currentPath);
  };

  const handleDelete = async (targetPath?: string) => {
    const paths = targetPath ? [targetPath] : entries.filter(e => selectedEntries.has(e.fullPath)).map(e => e.fullPath);
    if (paths.length === 0) return;
    // Note: delete is not undoable (files are gone). We could move to trash instead.
    for (const p of paths) {
      await window.electron?.explorer?.delete(p);
    }
    setSelectedEntries(new Set());
    loadDirectory(currentPath);
  };

  const handleCopy = (path: string, name: string) => {
    setClipboard({ path, name, cut: false });
  };

  const handleCut = (path: string, name: string) => {
    setClipboard({ path, name, cut: true });
  };

  const handlePaste = async () => {
    if (!clipboard || !currentPath) return;
    const dest = joinPath(currentPath, clipboard.name);
    if (clipboard.cut) {
      await window.electron?.explorer?.rename(clipboard.path, dest);
      setClipboard(null);
    } else {
      await window.electron?.explorer?.copy(clipboard.path, dest);
    }
    loadDirectory(currentPath);
  };

  const handleCreateFile = async () => {
    if (!newItemName.trim() || !currentPath) return;
    const filePath = joinPath(currentPath, newItemName.trim());
    await window.electron?.explorer?.createFile(filePath);
    setNewItemType(null);
    setNewItemName('');
    loadDirectory(currentPath);
  };

  const handleCreateFolder = async () => {
    if (!newItemName.trim() || !currentPath) return;
    const dirPath = joinPath(currentPath, newItemName.trim());
    await window.electron?.explorer?.createFolder(dirPath);
    setNewItemType(null);
    setNewItemName('');
    loadDirectory(currentPath);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const visible = filterText
          ? entries.filter((en) => en.name.toLowerCase().includes(filterText.toLowerCase()))
          : entries;
        setSelectedEntries(new Set(visible.map(en => en.fullPath)));
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
  }, [entries, selectedEntries, clipboard, currentPath, filterText]);

  // Lasso (rubber-band) selection
  const handleLassoStart = useCallback((e: React.MouseEvent) => {
    // Only start on empty space (left button, no entry clicked)
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-entry], tr[class*="MuiTableRow"]')) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    lassoDragged.current = false;
    lassoStart.current = {
      x: e.clientX - rect.left + container.scrollLeft,
      y: e.clientY - rect.top + container.scrollTop,
      scrollX: container.scrollLeft,
      scrollY: container.scrollTop,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!lassoStart.current || !containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      const curX = moveEvent.clientX - r.left + containerRef.current.scrollLeft;
      const curY = moveEvent.clientY - r.top + containerRef.current.scrollTop;
      const sx = lassoStart.current.x;
      const sy = lassoStart.current.y;
      const lx = Math.min(sx, curX);
      const ly = Math.min(sy, curY);
      const lw = Math.abs(curX - sx);
      const lh = Math.abs(curY - sy);
      if (lw > 5 || lh > 5) lassoDragged.current = true;
      setLasso({ x: lx, y: ly, w: lw, h: lh });

      // Find entries whose DOM elements intersect the lasso
      const entryEls = containerRef.current.querySelectorAll('[data-entry-path]');
      const selected = new Set<string>();
      entryEls.forEach((el) => {
        const elRect = el.getBoundingClientRect();
        const elX = elRect.left - r.left + containerRef.current!.scrollLeft;
        const elY = elRect.top - r.top + containerRef.current!.scrollTop;
        const elW = elRect.width;
        const elH = elRect.height;
        // Rectangle intersection test
        if (elX < lx + lw && elX + elW > lx && elY < ly + lh && elY + elH > ly) {
          const path = el.getAttribute('data-entry-path');
          if (path) selected.add(path);
        }
      });
      setSelectedEntries(selected);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      lassoStart.current = null;
      setLasso(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
  }, []);

  const handleGoUp = () => {
    if (isRoot || !currentPath) return;
    const parts = currentPath.split(SEP).filter(Boolean);
    parts.pop();
    const parent = parts.length === 0 ? '' : (OPERATING_SYSTEM === 'win32' ? '' : '/') + parts.join(SEP) + (OPERATING_SYSTEM === 'win32' ? SEP : '');
    loadDirectory(parent || '');
  };

  const handleGoHome = () => {
    loadDirectory('');
  };

  // Build breadcrumb segments from currentPath
  const breadcrumbSegments: { label: string; path: string }[] = [];
  if (currentPath) {
    const sep = SEP;
    const parts = currentPath.split(sep).filter(Boolean);
    let accumulated = currentPath.startsWith('/') ? '/' : '';
    for (const part of parts) {
      accumulated += (accumulated && !accumulated.endsWith(sep) ? sep : '') + part;
      breadcrumbSegments.push({ label: part, path: accumulated });
    }
  }

  const filteredEntries = filterText
    ? entries.filter((e) => e.name.toLowerCase().includes(filterText.toLowerCase()))
    : entries;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Tooltip title="Home">
          <IconButton size="small" onClick={handleGoHome} sx={{ color: 'text.secondary' }}>
            <HomeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Go up">
          <span>
            <IconButton size="small" onClick={handleGoUp} disabled={isRoot} sx={{ color: 'text.secondary' }}>
              <UpIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        {editingPath ? (
          <TextField
            size="small"
            fullWidth
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const input = pathInput.trim();
                if (input) {
                  // Try listing as directory first; if it fails, try opening as file
                  const result = await window.electron.explorer.listDirectory(input);
                  if (result.entries.length > 0 || !result.error) {
                    loadDirectory(input);
                  } else {
                    // Might be a file path — try opening in editor
                    openFile({ name: input.split(/[\\/]/).pop() || input, fullPath: input, type: 'file', size: 0, modified: null, extension: '' });
                  }
                } else {
                  loadDirectory('');
                }
                setEditingPath(false);
              } else if (e.key === 'Escape') {
                setEditingPath(false);
              }
            }}
            onBlur={() => setEditingPath(false)}
            sx={{ flex: 1, '& .MuiInputBase-input': { fontSize: '0.8rem', py: 0.5 } }}
          />
        ) : (
          <Breadcrumbs
            separator="›"
            onClick={() => { setPathInput(currentPath); setEditingPath(true); }}
            sx={{ flex: 1, cursor: 'text', '& .MuiBreadcrumbs-separator': { mx: 0.5, color: 'text.secondary' } }}
          >
            {breadcrumbSegments.map((seg, i) => (
              i === breadcrumbSegments.length - 1 ? (
                <Typography key={seg.path} sx={{ fontSize: '0.8rem', fontWeight: 600 }}>
                  {seg.label}
                </Typography>
              ) : (
                <Link
                  key={seg.path}
                  component="button"
                  underline="hover"
                  onClick={(e) => { e.stopPropagation(); loadDirectory(seg.path); }}
                  sx={{ fontSize: '0.8rem', color: 'text.secondary', cursor: 'pointer' }}
                >
                  {seg.label}
                </Link>
              )
            ))}
          </Breadcrumbs>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
          <TextField
            size="small"
            placeholder="Search"
            value={filterText}
            onChange={(e) => {
              const value = e.target.value;
              setFilterText(value);
              if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
              if (!value.trim()) {
                setSearchResults(null);
                setIsSearching(false);
                return;
              }
              setIsSearching(true);
              setSearchResults({ names: [], matches: [] });
              // Cancel previous streaming search
              window.electron?.explorer?.searchContentCancel?.();
              contentCleanupRef.current.forEach((fn) => fn());
              contentCleanupRef.current = [];

              searchTimerRef.current = setTimeout(async () => {
                if (!currentPath || !window.electron?.explorer) {
                  setIsSearching(false);
                  return;
                }
                const q = value.trim();
                const opts = { caseSensitive, wholeWord };

                // Phase 1: name matches
                try {
                  const names = await window.electron.explorer.searchNames(q, currentPath, opts);
                  setSearchResults((prev) => ({ names, matches: prev?.matches || [] }));
                } catch {}

                // Phase 2: streaming content matches
                const offBatch = window.electron.explorer.onSearchContentBatch((batch) => {
                  setSearchResults((prev) => ({
                    names: prev?.names || [],
                    matches: [...(prev?.matches || []), ...batch],
                  }));
                });
                const offDone = window.electron.explorer.onSearchContentDone(() => {
                  setIsSearching(false);
                });
                contentCleanupRef.current = [offBatch, offDone];

                window.electron.explorer.searchContentStart(q, currentPath, opts);
              }, 300);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilterText('');
                setSearchResults(null);
                setIsSearching(false);
                if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                window.electron?.explorer?.searchContentCancel?.();
                contentCleanupRef.current.forEach((fn) => fn());
                contentCleanupRef.current = [];
              }
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                  </InputAdornment>
                ),
                endAdornment: filterText ? (
                  <InputAdornment position="end">
                    {isSearching ? (
                      <CircularProgress size={14} />
                    ) : (
                      <IconButton size="small" onClick={() => { setFilterText(''); setSearchResults(null); }} sx={{ p: 0.25 }}>
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    )}
                  </InputAdornment>
                ) : undefined,
              },
            }}
            sx={{
              width: 200,
              '& .MuiInputBase-input': { fontSize: '0.8rem', py: 0.5 },
              '& .MuiOutlinedInput-root': { pr: filterText ? 0.5 : 1 },
            }}
          />
          <Tooltip title="Match Case">
            <IconButton
              size="small"
              onClick={() => setCaseSensitive((v) => !v)}
              sx={{
                fontSize: '0.75rem', fontWeight: 700, width: 24, height: 24,
                color: caseSensitive ? 'primary.main' : 'text.disabled',
                border: 1, borderColor: caseSensitive ? 'primary.main' : 'transparent',
                borderRadius: 0.5,
              }}
            >
              Aa
            </IconButton>
          </Tooltip>
          <Tooltip title="Match Whole Word">
            <IconButton
              size="small"
              onClick={() => setWholeWord((v) => !v)}
              sx={{
                fontSize: '0.7rem', fontWeight: 700, width: 24, height: 24,
                color: wholeWord ? 'primary.main' : 'text.disabled',
                border: 1, borderColor: wholeWord ? 'primary.main' : 'transparent',
                borderRadius: 0.5,
              }}
            >
              W
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ display: 'flex', gap: 0.25 }}>
          <Tooltip title="List view">
            <IconButton
              size="small"
              onClick={() => setViewMode('list')}
              sx={{ color: viewMode === 'list' ? 'text.primary' : 'text.secondary', opacity: viewMode === 'list' ? 1 : 0.5 }}
            >
              <ListViewIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Icon view">
            <IconButton
              size="small"
              onClick={() => setViewMode('grid')}
              sx={{ color: viewMode === 'grid' ? 'text.primary' : 'text.secondary', opacity: viewMode === 'grid' ? 1 : 0.5 }}
            >
              <GridViewIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Search results — VS Code style */}
      {searchResults !== null ? (() => {
        // Group content matches by file
        const grouped = new Map<string, Array<{ line: number; snippet: string }>>();
        for (const m of searchResults.matches) {
          if (!grouped.has(m.path)) grouped.set(m.path, []);
          grouped.get(m.path)!.push({ line: m.line, snippet: m.snippet });
        }
        const totalContentMatches = searchResults.matches.length;
        const totalFiles = grouped.size;
        const totalNames = searchResults.names.length;
        const hasResults = totalNames > 0 || totalContentMatches > 0;

        return (
          <Box sx={{ flex: 1, overflow: 'auto' }}>
            {/* Summary bar */}
            {hasResults && (
              <Box sx={{ px: 2, py: 0.75, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {totalContentMatches} result{totalContentMatches !== 1 ? 's' : ''} in {totalFiles} file{totalFiles !== 1 ? 's' : ''}
                  {totalNames > 0 ? ` + ${totalNames} name match${totalNames !== 1 ? 'es' : ''}` : ''}
                </Typography>
                {isSearching && <CircularProgress size={12} />}
              </Box>
            )}

            {!hasResults && (
              <Typography sx={{ textAlign: 'center', py: 4, color: 'text.secondary', fontSize: '0.85rem' }}>
                {isSearching ? 'Searching...' : 'No results found.'}
              </Typography>
            )}

            {/* Name matches */}
            {searchResults.names.map((item, i) => {
              const relativePath = item.path.startsWith(currentPath)
                ? item.path.substring(currentPath.length).replace(/^[\\/]/, '')
                : item.path;
              return (
                <Box
                  key={`name-${i}`}
                  onClick={() => item.type === 'directory' ? loadDirectory(item.path) : openFile({
                    name: item.name, fullPath: item.path, type: 'file', size: 0, modified: null,
                    extension: item.name.includes('.') ? '.' + item.name.split('.').pop() : '',
                  })}
                  sx={{
                    px: 1.5, py: 0.5, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 1,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  {getFileIcon(item.name, item.type === 'directory')}
                  <Typography variant="body2" sx={{ fontSize: '0.8rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Highlight text={relativePath} query={filterText} caseSensitive={caseSensitive} />
                  </Typography>
                </Box>
              );
            })}

            {/* Content matches grouped by file */}
            {Array.from(grouped.entries()).map(([filePath, matches]) => {
              const fileName = filePath.split(/[\\/]/).pop() || filePath;
              const dir = filePath.startsWith(currentPath)
                ? filePath.substring(currentPath.length).replace(/^[\\/]/, '').replace(/[\\/][^\\/]+$/, '')
                : filePath.replace(/[\\/][^\\/]+$/, '');
              const isCollapsed = collapsedFiles.has(filePath);

              return (
                <Box key={filePath}>
                  {/* File header */}
                  <Box
                    onClick={() => setCollapsedFiles((prev) => {
                      const next = new Set(prev);
                      next.has(filePath) ? next.delete(filePath) : next.add(filePath);
                      return next;
                    })}
                    sx={{
                      px: 1, py: 0.5, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 0.5,
                      '&:hover': { bgcolor: 'action.hover' },
                      position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1,
                    }}
                  >
                    <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary', width: 12, textAlign: 'center', userSelect: 'none' }}>
                      {isCollapsed ? '>' : 'v'}
                    </Typography>
                    {getFileIcon(fileName, false)}
                    <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
                      {fileName}
                    </Typography>
                    {dir && (
                      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {dir}
                      </Typography>
                    )}
                    <Box sx={{
                      bgcolor: 'action.selected', borderRadius: 3, px: 0.75, minWidth: 20,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Typography variant="caption" sx={{ fontSize: '0.7rem', fontWeight: 600 }}>
                        {matches.length}
                      </Typography>
                    </Box>
                  </Box>

                  {/* Match lines */}
                  {!isCollapsed && matches.map((match, j) => {
                    let snippet = match.snippet;
                    const qi = (caseSensitive ? snippet : snippet.toLowerCase()).indexOf(caseSensitive ? filterText : filterText.toLowerCase());
                    if (qi > 30) snippet = '...' + snippet.substring(qi - 20);
                    if (snippet.length > 120) snippet = snippet.substring(0, 120) + '...';

                    return (
                      <Box
                        key={j}
                        onClick={() => openFile({
                          name: fileName, fullPath: filePath, type: 'file', size: 0, modified: null,
                          extension: fileName.includes('.') ? '.' + fileName.split('.').pop() : '',
                        })}
                        sx={{
                          pl: 4.5, pr: 1.5, py: 0.25, cursor: 'pointer',
                          '&:hover': { bgcolor: 'action.hover' },
                          display: 'flex', alignItems: 'baseline', gap: 1,
                          overflow: 'hidden',
                        }}
                      >
                        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, width: 32, textAlign: 'right', fontSize: '0.7rem' }}>
                          {match.line}
                        </Typography>
                        <Typography variant="caption" component="div" sx={{
                          fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                        }}>
                          <Highlight text={snippet} query={filterText} caseSensitive={caseSensitive} />
                        </Typography>
                      </Box>
                    );
                  })}
                </Box>
              );
            })}
          </Box>
        );
      })() :

      /* File list */
      isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      ) : viewMode === 'grid' ? (
        /* Grid/icon view */
        <Box
          ref={containerRef}
          onMouseDown={handleLassoStart}
          sx={{ flex: 1, overflow: 'auto', p: 2, position: 'relative' }}
          onClick={(e) => {
            if (lassoDragged.current) { lassoDragged.current = false; return; }
            if (e.shiftKey || e.ctrlKey || e.metaKey) return;
            if (!(e.target as HTMLElement).closest('[data-entry]')) {
              setSelectedEntries(new Set());
            }
          }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('[data-entry]')) return;
            e.preventDefault();
            if (currentPath) {
              setBgContextMenu({ mouseX: e.clientX, mouseY: e.clientY });
            }
          }}
        >
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {filteredEntries.map((entry) => (
              <Box
                key={entry.fullPath}
                data-entry
                data-entry-path={entry.fullPath}
                onClick={(e) => handleEntryClick(e, entry)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
                onContextMenu={(e) => handleContextMenu(e, entry)}
                sx={{
                  width: 96,
                  display: 'flex',
                  flexDirection: 'column',
                  bgcolor: selectedEntries.has(entry.fullPath) ? 'action.selected' : undefined,
                  alignItems: 'center',
                  gap: 0.5,
                  p: 1,
                  borderRadius: 1,
                  cursor: 'pointer',
                  userSelect: 'none',
                  '&:hover': { bgcolor: 'action.hover' },
                  transition: 'background-color 100ms ease',
                }}
              >
                <Box sx={{ '& svg': { width: 40, height: 40 } }}>
                  {getFileIcon(entry.name, entry.type, false, isRoot)}
                </Box>
                <Typography
                  variant="caption"
                  sx={{
                    fontSize: '0.7rem',
                    textAlign: 'center',
                    lineHeight: 1.2,
                    wordBreak: 'break-all',
                    maxHeight: '2.4em',
                    overflow: 'hidden',
                  }}
                >
                  {entry.name}
                </Typography>
              </Box>
            ))}
          </Box>
          {filteredEntries.length === 0 && (
            <Typography sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
              {filterText ? 'No matches' : 'Empty directory'}
            </Typography>
          )}
        </Box>
      ) : (
        <TableContainer
          ref={containerRef}
          onMouseDown={handleLassoStart}
          sx={{ flex: 1, overflow: 'auto', position: 'relative' }}
          onClick={(e) => {
            if (lassoDragged.current) { lassoDragged.current = false; return; }
            if (e.shiftKey || e.ctrlKey || e.metaKey) return;
            if (!(e.target as HTMLElement).closest('tr[class*="MuiTableRow"]')) {
              setSelectedEntries(new Set());
            }
          }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('tr[class*="MuiTableRow"]')) return;
            e.preventDefault();
            // Only show folder context menu if we're in a directory (not root)
            if (currentPath) {
              setBgContextMenu({ mouseX: e.clientX, mouseY: e.clientY });
            }
          }}
        >
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', py: 0.75 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', py: 0.75, width: 100 }} align="right">Size</TableCell>
                <TableCell sx={{ fontWeight: 600, fontSize: '0.75rem', color: 'text.secondary', py: 0.75, width: 180 }}>Modified</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredEntries.map((entry) => (
                <TableRow
                  key={entry.fullPath}
                  hover
                  selected={selectedEntries.has(entry.fullPath)}
                  data-entry-path={entry.fullPath}
                  onClick={(e) => handleEntryClick(e, entry)}
                  onDoubleClick={() => handleEntryDoubleClick(entry)}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                  sx={{
                    cursor: 'pointer',
                    '& td': { py: 0.75, borderColor: 'divider' },
                    transition: 'background-color 100ms ease',
                  }}
                >
                  <TableCell>
                    <Tooltip title={entry.name} enterDelay={500} placement="top-start">
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                        {getFileIcon(entry.name, entry.type, false, isRoot)}
                        <Typography variant="body2" noWrap sx={{ fontSize: '0.8rem' }}>
                          {entry.name}
                        </Typography>
                      </Box>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                      {entry.type === 'file' ? formatFileSize(entry.size) : '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                      {formatDate(entry.modified)}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
              {filteredEntries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                    {filterText ? 'No matches' : 'Empty directory'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {/* Lasso selection rectangle */}
      {lasso && containerRef.current && (
        <Box
          sx={{
            position: 'fixed',
            left: containerRef.current.getBoundingClientRect().left + lasso.x - containerRef.current.scrollLeft,
            top: containerRef.current.getBoundingClientRect().top + lasso.y - containerRef.current.scrollTop,
            width: lasso.w,
            height: lasso.h,
            border: '1px solid',
            borderColor: 'info.main',
            bgcolor: 'rgba(37, 99, 235, 0.08)',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        />
      )}

      {/* Context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              // Add right-clicked entry (or all selected if it's in the selection)
              const toAdd = selectedEntries.has(contextMenu.entry.fullPath)
                ? entries.filter(e => selectedEntries.has(e.fullPath))
                : [contextMenu.entry];
              for (const entry of toAdd) {
                addSelection({
                  filePath: entry.fullPath,
                  fileName: entry.name,
                  startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, text: '',
                });
              }
              setSelectedEntries(new Set());
            }
            setContextMenu(null);
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>
            {selectedEntries.size > 1 && contextMenu && selectedEntries.has(contextMenu.entry.fullPath)
              ? `Add ${selectedEntries.size} items to Chat`
              : 'Add to Chat'}
          </ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>F3</Typography>
        </MenuItem>
        {!isRoot && (<>
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              setRenaming({ path: contextMenu.entry.fullPath, name: contextMenu.entry.name });
              setRenameValue(contextMenu.entry.name);
            }
            setContextMenu(null);
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Rename</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>F2</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (contextMenu) handleCopy(contextMenu.entry.fullPath, contextMenu.entry.name);
            setContextMenu(null);
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Copy</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Ctrl+C</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (contextMenu) handleCut(contextMenu.entry.fullPath, contextMenu.entry.name);
            setContextMenu(null);
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Cut</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Ctrl+X</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (contextMenu) handleDelete(contextMenu.entry.fullPath);
            setContextMenu(null);
          }}
          sx={{ fontSize: '0.8rem', color: 'error.main' }}
        >
          <ListItemText>Delete</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Del</Typography>
        </MenuItem>
        </>)}
        {hasVSCode && (
          <MenuItem onClick={handleOpenInVSCode} sx={{ fontSize: '0.8rem' }}>
            <ListItemText>Open with VS Code</ListItemText>
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              window.electron?.openPath(contextMenu.entry.fullPath);
              setContextMenu(null);
            }
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Open with Default App</ListItemText>
        </MenuItem>
      </Menu>

      {/* Background context menu (right-click empty space) */}
      <Menu
        open={bgContextMenu !== null}
        onClose={() => setBgContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={bgContextMenu ? { top: bgContextMenu.mouseY, left: bgContextMenu.mouseX } : undefined}
      >
        <MenuItem
          onClick={() => { setNewItemType('file'); setNewItemName(''); setBgContextMenu(null); }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>New File</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => { setNewItemType('folder'); setNewItemName(''); setBgContextMenu(null); }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>New Folder</ListItemText>
        </MenuItem>
        {clipboard && (
          <MenuItem
            onClick={() => { handlePaste(); setBgContextMenu(null); }}
            sx={{ fontSize: '0.8rem' }}
          >
            <ListItemText>Paste ({clipboard.name})</ListItemText>
            <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Ctrl+V</Typography>
          </MenuItem>
        )}
        {hasVSCode && currentPath && (
          <MenuItem
            onClick={() => {
              window.electron?.explorer?.openInVSCode(currentPath);
              setBgContextMenu(null);
            }}
            sx={{ fontSize: '0.8rem' }}
          >
            <ListItemText>Open Folder in VS Code</ListItemText>
          </MenuItem>
        )}
      </Menu>
      {/* Rename dialog */}
      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Rename</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(null); }}
            size="small"
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(null)}>Cancel</Button>
          <Button onClick={handleRename} variant="contained">Rename</Button>
        </DialogActions>
      </Dialog>

      {/* New file/folder dialog */}
      <Dialog open={newItemType !== null} onClose={() => setNewItemType(null)} maxWidth="xs" fullWidth>
        <DialogTitle>New {newItemType === 'folder' ? 'Folder' : 'File'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            placeholder={newItemType === 'folder' ? 'folder-name' : 'filename.txt'}
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { newItemType === 'folder' ? handleCreateFolder() : handleCreateFile(); }
              if (e.key === 'Escape') setNewItemType(null);
            }}
            size="small"
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewItemType(null)}>Cancel</Button>
          <Button onClick={newItemType === 'folder' ? handleCreateFolder : handleCreateFile} variant="contained">Create</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
