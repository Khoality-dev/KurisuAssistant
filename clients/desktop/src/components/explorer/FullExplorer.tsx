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
} from '@mui/material';
import {
  ArrowUpward as UpIcon,
  Home as HomeIcon,
  ViewList as ListViewIcon,
  GridView as GridViewIcon,
} from '@mui/icons-material';
import { getFileIcon } from './FileIcon';
import { useExplorerStore, type FileEntry } from '../../store/explorerStore';

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
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
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

  // Ctrl+A to select all
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // Only if explorer is focused (not in an input)
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        setSelectedEntries(new Set(entries.map(e => e.fullPath)));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [entries]);

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
    // Go to parent directory
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const parts = currentPath.split(sep).filter(Boolean);
    parts.pop();
    const parent = parts.length === 0 ? '' : (currentPath.startsWith('/') ? '/' : '') + parts.join(sep) + (currentPath.includes('\\') ? '\\' : '');
    loadDirectory(parent || '');
  };

  const handleGoHome = () => {
    loadDirectory('');
  };

  // Build breadcrumb segments from currentPath
  const breadcrumbSegments: { label: string; path: string }[] = [];
  if (currentPath) {
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const parts = currentPath.split(sep).filter(Boolean);
    let accumulated = currentPath.startsWith('/') ? '/' : '';
    for (const part of parts) {
      accumulated += (accumulated && !accumulated.endsWith(sep) ? sep : '') + part;
      breadcrumbSegments.push({ label: part, path: accumulated });
    }
  }

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

      {/* File list */}
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
                  {getFileIcon(entry.name, entry.type)}
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
                        {getFileIcon(entry.name, entry.type)}
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
        </MenuItem>
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
    </Box>
  );
};
