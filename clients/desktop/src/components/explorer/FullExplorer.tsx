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
  TextField,
} from '@mui/material';
import {
  ArrowUpward as UpIcon,
  Home as HomeIcon,
  ViewList as ListViewIcon,
  GridView as GridViewIcon,
} from '@mui/icons-material';
import { getFileIcon } from './FileIcon';
import { SearchBar, Highlight } from './SearchPanel';
import { ExplorerContextMenus } from './ExplorerContextMenus';
import { ExplorerDialogs } from './ExplorerDialogs';
import { useExplorerStore, type FileEntry } from '../../store/explorerStore';
import { useFileOperations } from '../../hooks/useFileOperations';

const OPERATING_SYSTEM = window.electron?.platform ?? 'win32';
const SEP = OPERATING_SYSTEM === 'win32' ? '\\' : '/';

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

// --- Search result types ---
interface SearchResults {
  names: Array<{ path: string; name: string; type: 'file' | 'directory' }>;
  matches: Array<{ path: string; line: number; snippet: string }>;
}

export const FullExplorer: React.FC = () => {
  const { openFile, viewMode, setViewMode, addSelection, setLiveSelections } = useExplorerStore();

  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [lasso, setLasso] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const lassoStart = useRef<{ x: number; y: number; scrollX: number; scrollY: number } | null>(null);
  const lassoDragged = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasVSCode, setHasVSCode] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; entry: FileEntry } | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ mouseX: number; mouseY: number } | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRoot, setIsRoot] = useState(true);

  // Search state
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const contentCleanupRef = useRef<Array<() => void>>([]);

  const cancelSearch = useCallback(() => {
    window.electron?.explorer?.searchContentCancel?.();
    contentCleanupRef.current.forEach((fn) => fn());
    contentCleanupRef.current = [];
  }, []);

  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!window.electron?.explorer) return;
    setIsLoading(true);
    setSelectedEntries(new Set());
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

  // Sync selected entries -> live selection chips
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
        startColumn: 0,
        endColumn: 0,
        isWholeFile: true,
      }));
    setLiveSelections(sels);
  }, [selectedEntries, entries, setLiveSelections]);

  // Check if VS Code is available
  useEffect(() => {
    window.electron?.explorer?.hasVSCode?.().then(setHasVSCode).catch(() => {});
  }, []);

  // Clean up search on unmount
  useEffect(() => () => cancelSearch(), [cancelSearch]);

  const handleSearch = useCallback((query: string, opts: { caseSensitive: boolean; wholeWord: boolean }) => {
    cancelSearch();
    setSearchQuery(query);
    setSearchCaseSensitive(opts.caseSensitive);

    if (!query.trim() || !currentPath || !window.electron?.explorer) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setSearchResults({ names: [], matches: [] });
    setCollapsedFiles(new Set());

    const q = query.trim();

    // Phase 1: name matches
    window.electron.explorer.searchNames(q, currentPath, opts).then((names) => {
      setSearchResults((prev) => ({ names, matches: prev?.matches || [] }));
    }).catch(() => {});

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
  }, [currentPath, cancelSearch]);

  const handleSearchClose = useCallback(() => {
    cancelSearch();
    setSearchResults(null);
    setIsSearching(false);
    setSearchQuery('');
  }, [cancelSearch]);

  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY, entry });
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

  // File operations hook (clipboard, rename, create, delete, copy, cut, paste, keyboard shortcuts)
  const {
    clipboard,
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
  } = useFileOperations({
    currentPath,
    entries,
    selectedEntries,
    setSelectedEntries,
    loadEntries: loadDirectory,
    searchInputRef,
  });

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

  // --- Grouped search results ---
  const searchActive = searchResults !== null;
  const contentByFile = new Map<string, Array<{ line: number; snippet: string }>>();
  if (searchResults) {
    for (const m of searchResults.matches) {
      if (!contentByFile.has(m.path)) contentByFile.set(m.path, []);
      contentByFile.get(m.path)!.push({ line: m.line, snippet: m.snippet });
    }
  }
  const contentFilePaths = new Set(contentByFile.keys());
  const nameOnlyMatches = searchResults?.names.filter((n) => !contentFilePaths.has(n.path)) || [];
  const totalContentMatches = searchResults?.matches.length || 0;
  const totalFiles = contentByFile.size;
  const hasResults = nameOnlyMatches.length > 0 || totalContentMatches > 0;

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

        {/* Search bar in toolbar */}
        <Box sx={{ width: 280, flexShrink: 0 }}>
          <SearchBar
            inputRef={searchInputRef}
            visible
            inline
            onClose={handleSearchClose}
            onSearch={handleSearch}
            searching={isSearching}
          />
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

      {/* Search results (replaces file list when active) */}
      {searchActive && (
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {/* Summary */}
          {hasResults && (
            <Box sx={{ px: 2, py: 0.5, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {totalContentMatches} result{totalContentMatches !== 1 ? 's' : ''} in {totalFiles} file{totalFiles !== 1 ? 's' : ''}
                {nameOnlyMatches.length > 0 ? ` + ${nameOnlyMatches.length} name match${nameOnlyMatches.length !== 1 ? 'es' : ''}` : ''}
              </Typography>
              {isSearching && <CircularProgress size={12} />}
            </Box>
          )}

          {!hasResults && !isSearching && (
            <Typography sx={{ textAlign: 'center', py: 4, color: 'text.secondary', fontSize: '0.85rem' }}>
              No results found.
            </Typography>
          )}

          {/* Name-only matches */}
          {nameOnlyMatches.map((item, i) => {
            const relativePath = item.path.startsWith(currentPath)
              ? item.path.substring(currentPath.length).replace(/^[\\/]/, '')
              : item.path;
            return (
              <Box
                key={`name-${i}`}
                onClick={() => item.type === 'directory'
                  ? loadDirectory(item.path)
                  : openFile({ name: item.name, fullPath: item.path, type: 'file', size: 0, modified: null, extension: item.name.includes('.') ? '.' + item.name.split('.').pop() : '' })
                }
                sx={{
                  display: 'flex', alignItems: 'center', height: 28, px: 1.5, gap: 1,
                  cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                {getFileIcon(item.name, item.type)}
                <Typography variant="body2" noWrap sx={{ fontSize: '0.8rem', flex: 1 }}>
                  <Highlight text={relativePath} query={searchQuery} caseSensitive={searchCaseSensitive} />
                </Typography>
              </Box>
            );
          })}

          {/* Content matches grouped by file */}
          {Array.from(contentByFile.entries()).map(([filePath, matches]) => {
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            const relDir = filePath.startsWith(currentPath)
              ? filePath.substring(currentPath.length).replace(/^[\\/]/, '').replace(/[\\/][^\\/]+$/, '')
              : filePath.replace(/[\\/][^\\/]+$/, '');
            const isCollapsed = collapsedFiles.has(filePath);
            const nameMatched = searchResults?.names.some((n) => n.path === filePath);

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
                    display: 'flex', alignItems: 'center', height: 28,
                    px: 1, gap: 0.5,
                    cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
                    position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1,
                  }}
                >
                  <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary', width: 12, textAlign: 'center', userSelect: 'none' }}>
                    {isCollapsed ? '>' : 'v'}
                  </Typography>
                  {getFileIcon(fileName, 'file')}
                  <Typography variant="body2" noWrap sx={{ fontWeight: 600, fontSize: '0.8rem', flex: 1 }}>
                    {nameMatched ? <Highlight text={fileName} query={searchQuery} caseSensitive={searchCaseSensitive} /> : fileName}
                  </Typography>
                  {relDir && (
                    <Typography variant="caption" noWrap color="text.secondary" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {relDir}
                    </Typography>
                  )}
                  <Box sx={{
                    bgcolor: 'action.selected', borderRadius: 3, px: 0.75, minWidth: 18,
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
                  const qi = (searchCaseSensitive ? snippet : snippet.toLowerCase()).indexOf(searchCaseSensitive ? searchQuery : searchQuery.toLowerCase());
                  if (qi > 30) snippet = '...' + snippet.substring(qi - 20);
                  if (snippet.length > 120) snippet = snippet.substring(0, 120) + '...';

                  return (
                    <Box
                      key={j}
                      onClick={() => openFile({ name: fileName, fullPath: filePath, type: 'file', size: 0, modified: null, extension: fileName.includes('.') ? '.' + fileName.split('.').pop() : '' })}
                      sx={{
                        display: 'flex', alignItems: 'baseline', height: 24,
                        pl: 4.5, pr: 1.5, gap: 0.5,
                        cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' }, overflow: 'hidden',
                      }}
                    >
                      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, width: 32, textAlign: 'right', fontSize: '0.7rem' }}>
                        {match.line}
                      </Typography>
                      <Typography variant="caption" component="div" noWrap sx={{
                        fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary', flex: 1,
                      }}>
                        <Highlight text={snippet} query={searchQuery} caseSensitive={searchCaseSensitive} />
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            );
          })}
        </Box>
      )}

      {/* File list (hidden when search is active) */}
      {!searchActive && (
        <>
          {isLoading ? (
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
                {entries.map((entry) => (
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
              {entries.length === 0 && (
                <Typography sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                  Empty directory
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
                  {entries.map((entry) => (
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
                  {entries.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                        Empty directory
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
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

      <ExplorerContextMenus
        contextMenu={contextMenu}
        onCloseContextMenu={() => setContextMenu(null)}
        bgContextMenu={bgContextMenu}
        onCloseBgContextMenu={() => setBgContextMenu(null)}
        selectedEntries={selectedEntries}
        entries={entries}
        clipboard={clipboard}
        hasVSCode={hasVSCode}
        isRoot={isRoot}
        currentPath={currentPath}
        onAddToChat={(toAdd) => {
          for (const entry of toAdd) {
            addSelection({
              filePath: entry.fullPath,
              fileName: entry.name,
              startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, text: '',
            });
          }
          setSelectedEntries(new Set());
        }}
        onRename={(path, name) => {
          setRenaming({ path, name });
          setRenameValue(name);
        }}
        onCopy={handleCopy}
        onCut={handleCut}
        onDelete={handleDelete}
        onPaste={handlePaste}
        onNewFile={() => { setNewItemType('file'); setNewItemName(''); }}
        onNewFolder={() => { setNewItemType('folder'); setNewItemName(''); }}
      />

      <ExplorerDialogs
        renaming={renaming}
        renameValue={renameValue}
        onRenameValueChange={setRenameValue}
        onRenameSubmit={handleRename}
        onRenameCancel={() => setRenaming(null)}
        newItemType={newItemType}
        newItemName={newItemName}
        onNewItemNameChange={setNewItemName}
        onCreateFile={handleCreateFile}
        onCreateFolder={handleCreateFolder}
        onNewItemCancel={() => setNewItemType(null)}
      />
    </Box>
  );
};
