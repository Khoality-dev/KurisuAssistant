/**
 * Full-page file explorer — shown when no files are open in the editor.
 * Displays a browseable file/folder list with breadcrumb navigation.
 */

import React, { useCallback, useEffect, useState } from 'react';
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
  const { openFile } = useExplorerStore();

  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [hasVSCode, setHasVSCode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; entry: FileEntry } | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ mouseX: number; mouseY: number } | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRoot, setIsRoot] = useState(true);

  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!window.electron?.explorer) return;
    setIsLoading(true);
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

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.type === 'directory') {
      loadDirectory(entry.fullPath);
    } else {
      openFile(entry);
    }
  };

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

        <Breadcrumbs
          separator="›"
          sx={{ flex: 1, '& .MuiBreadcrumbs-separator': { mx: 0.5, color: 'text.secondary' } }}
        >
          <Link
            component="button"
            underline="hover"
            onClick={handleGoHome}
            sx={{ fontSize: '0.8rem', color: 'text.secondary', cursor: 'pointer' }}
          >
            Root
          </Link>
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
                onClick={() => loadDirectory(seg.path)}
                sx={{ fontSize: '0.8rem', color: 'text.secondary', cursor: 'pointer' }}
              >
                {seg.label}
              </Link>
            )
          ))}
        </Breadcrumbs>

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
          sx={{ flex: 1, overflow: 'auto', p: 2 }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('[data-entry]')) return;
            e.preventDefault();
            setBgContextMenu({ mouseX: e.clientX, mouseY: e.clientY });
          }}
        >
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {entries.map((entry) => (
              <Box
                key={entry.fullPath}
                data-entry
                onClick={() => handleEntryClick(entry)}
                onContextMenu={(e) => handleContextMenu(e, entry)}
                sx={{
                  width: 96,
                  display: 'flex',
                  flexDirection: 'column',
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
          sx={{ flex: 1, overflow: 'auto' }}
          onContextMenu={(e) => {
            // Only fire if right-clicking empty space (not a row)
            if ((e.target as HTMLElement).closest('tr[class*="MuiTableRow"]')) return;
            e.preventDefault();
            setBgContextMenu({ mouseX: e.clientX, mouseY: e.clientY });
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
                  onClick={() => handleEntryClick(entry)}
                  onDoubleClick={() => entry.type === 'directory' && loadDirectory(entry.fullPath)}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                  sx={{
                    cursor: 'pointer',
                    '& td': { py: 0.75, borderColor: 'divider' },
                    transition: 'background-color 100ms ease',
                  }}
                >
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {getFileIcon(entry.name, entry.type)}
                      <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>
                        {entry.name}
                      </Typography>
                    </Box>
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
      {/* Context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
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
