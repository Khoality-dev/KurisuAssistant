import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography, CircularProgress, Menu, MenuItem, ListItemText, Tooltip, IconButton, TextField, InputAdornment } from '@mui/material';
import {
  ChevronRight as ChevronRightIcon,
  ExpandMore as ExpandMoreIcon,
  ArrowUpward as UpIcon,
  Search as SearchIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { ResizeHandle } from '../layout/ResizeHandle';
import { useLayoutStore } from '../../store/layoutStore';
import { getFileIcon } from './FileIcon';
import { useExplorerStore, type FileEntry } from '../../store/explorerStore';

interface TreeNode {
  entry: FileEntry;
  children: TreeNode[];
  isExpanded: boolean;
  isLoaded: boolean;
  isLoading: boolean;
}

const MIN_TREE_WIDTH = 160;
const MAX_TREE_WIDTH = 500;

export const FileTreeSidebar: React.FC = () => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { workspaceTreeWidth } = useLayoutStore();
  const { openFile, workspaceRoot } = useExplorerStore();
  const sidebarRef = useRef<HTMLDivElement>(null);

  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [isLoadingRoots, setIsLoadingRoots] = useState(true);
  const [hasVSCode, setHasVSCode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; entry: FileEntry } | null>(null);
  const [treeFilter, setTreeFilter] = useState('');
  const [showTreeFilter, setShowTreeFilter] = useState(false);
  const treeSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.electron?.explorer?.hasVSCode?.().then(setHasVSCode).catch(() => {});
  }, []);

  // Ctrl+F focuses tree search when sidebar has focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        // Only handle if focus is inside the sidebar
        if (sidebarRef.current?.contains(document.activeElement) || sidebarRef.current?.contains(e.target as Node)) {
          e.preventDefault();
          e.stopPropagation();
          setShowTreeFilter(true);
          setTimeout(() => {
            treeSearchRef.current?.focus();
            treeSearchRef.current?.select();
          }, 0);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // Load workspace root folder contents
  useEffect(() => {
    if (!window.electron?.explorer || !workspaceRoot) {
      setRootNodes([]);
      setIsLoadingRoots(false);
      return;
    }

    setIsLoadingRoots(true);
    window.electron.explorer.listDirectory(workspaceRoot).then((result) => {
      const nodes: TreeNode[] = result.entries.map((e) => ({
        entry: e,
        children: [],
        isExpanded: false,
        isLoaded: false,
        isLoading: false,
      }));
      setRootNodes(nodes);
      setIsLoadingRoots(false);
    }).catch(() => {
      setIsLoadingRoots(false);
    });
  }, [workspaceRoot]);

  // Toggle expand/collapse for a folder node
  const toggleExpand = useCallback(async (nodePath: string[]) => {
    setRootNodes((prev) => {
      const clone = deepCloneNodes(prev);
      const target = findNode(clone, nodePath);
      if (!target) return prev;

      if (target.isExpanded) {
        target.isExpanded = false;
        return clone;
      }

      if (target.isLoaded) {
        target.isExpanded = true;
        return clone;
      }

      target.isLoading = true;
      target.isExpanded = true;

      // Trigger async load
      window.electron.explorer.listDirectory(target.entry.fullPath).then((result) => {
        setRootNodes((current) => {
          const c = deepCloneNodes(current);
          const t = findNode(c, nodePath);
          if (!t) return current;

          t.children = result.entries.map((e: FileEntry) => ({
            entry: e,
            children: [],
            isExpanded: false,
            isLoaded: false,
            isLoading: false,
          }));
          t.isLoaded = true;
          t.isLoading = false;
          return c;
        });
      }).catch(() => {
        setRootNodes((current) => {
          const c = deepCloneNodes(current);
          const t = findNode(c, nodePath);
          if (!t) return current;
          t.isLoading = false;
          return c;
        });
      });

      return clone;
    });
  }, []);

  const handleTreeResizeEnd = useCallback((size: number) => {
    useLayoutStore.getState().setWorkspaceTreeWidth(size);
    useLayoutStore.getState().persistWidths();
  }, []);

  const handleFileClick = useCallback((entry: FileEntry) => {
    openFile(entry);
  }, [openFile]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY, entry });
  }, []);

  // Filter tree nodes by name (recursive — show parent if any child matches)
  const filteredNodes = useMemo(() => {
    if (!treeFilter) return rootNodes;
    const lowerFilter = treeFilter.toLowerCase();
    function filterNodes(nodes: TreeNode[]): TreeNode[] {
      const result: TreeNode[] = [];
      for (const node of nodes) {
        const nameMatch = node.entry.name.toLowerCase().includes(lowerFilter);
        const filteredChildren = filterNodes(node.children);
        if (nameMatch || filteredChildren.length > 0) {
          result.push({
            ...node,
            children: filteredChildren,
            isExpanded: filteredChildren.length > 0 ? true : node.isExpanded,
          });
        }
      }
      return result;
    }
    return filterNodes(rootNodes);
  }, [rootNodes, treeFilter]);

  return (
    <Box ref={sidebarRef} sx={{ display: 'flex', flexDirection: 'row', height: '100%', width: workspaceTreeWidth, flexShrink: 0 }}>
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          bgcolor: isDark ? '#0F0F0F' : '#F5F5F5',
          borderRight: 1,
          borderColor: 'divider',
        }}
      >
        {/* Header */}
        <Box
          sx={{
            px: 1,
            py: 0.75,
            flexShrink: 0,
            borderBottom: 1,
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
          }}
        >
          <Tooltip title="Go to parent folder" placement="bottom">
            <IconButton
              size="small"
              onClick={() => {
                if (!workspaceRoot) return;
                const sep = workspaceRoot.includes('\\') ? '\\' : '/';
                const parts = workspaceRoot.split(sep).filter(Boolean);
                parts.pop();
                const parent = parts.length === 0 ? '' : (workspaceRoot.startsWith('/') ? '/' : '') + parts.join(sep) + (workspaceRoot.includes('\\') ? '\\' : '');
                useExplorerStore.setState({ workspaceRoot: parent || workspaceRoot });
              }}
              sx={{ color: 'text.secondary', p: 0.5 }}
            >
              <UpIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={workspaceRoot} enterDelay={500} placement="bottom">
            <Typography
              variant="caption"
              noWrap
              sx={{
                fontWeight: 700,
                fontSize: '0.65rem',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'text.secondary',
                flex: 1,
                minWidth: 0,
              }}
            >
              {workspaceRoot ? workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || 'Explorer' : 'Explorer'}
            </Typography>
          </Tooltip>
        </Box>

        {/* Tree filter */}
        {showTreeFilter && (
          <Box sx={{ px: 0.5, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
            <TextField
              inputRef={treeSearchRef}
              size="small"
              fullWidth
              placeholder="Filter..."
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setTreeFilter(''); setShowTreeFilter(false); }
              }}
              autoFocus
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton size="small" onClick={() => { setTreeFilter(''); setShowTreeFilter(false); }} sx={{ p: 0.25 }}>
                        <CloseIcon sx={{ fontSize: 12 }} />
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
              sx={{
                '& .MuiInputBase-input': { fontSize: '0.75rem', py: 0.25 },
                '& .MuiOutlinedInput-root': { pr: 0.5 },
              }}
            />
          </Box>
        )}

        {/* Tree content */}
        <Box sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
          {isLoadingRoots && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={20} />
            </Box>
          )}

          {!isLoadingRoots && filteredNodes.map((node, i) => (
            <TreeNodeRow
              key={node.entry.fullPath}
              node={node}
              depth={0}
              path={[String(i)]}
              onToggle={toggleExpand}
              onFileClick={handleFileClick}
              onContextMenu={handleContextMenu}
            />
          ))}
        </Box>
      </Box>

      <ResizeHandle
        targetRef={sidebarRef}
        min={MIN_TREE_WIDTH}
        max={MAX_TREE_WIDTH}
        onResizeEnd={handleTreeResizeEnd}
      />

      {/* Context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              useExplorerStore.getState().addSelection({
                filePath: contextMenu.entry.fullPath,
                fileName: contextMenu.entry.name,
                startLine: 0,
                endLine: 0,
                startColumn: 0,
                endColumn: 0,
                text: '',
              });
            }
            setContextMenu(null);
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Add to Chat</ListItemText>
        </MenuItem>
        {contextMenu?.entry.type === 'directory' && (
          <MenuItem
            onClick={() => {
              if (contextMenu) {
                useExplorerStore.setState({ workspaceRoot: contextMenu.entry.fullPath });
              }
              setContextMenu(null);
            }}
            sx={{ fontSize: '0.8rem' }}
          >
            <ListItemText>Open Folder</ListItemText>
          </MenuItem>
        )}
        {hasVSCode && (
          <MenuItem
            onClick={() => {
              if (contextMenu) window.electron?.explorer?.openInVSCode(contextMenu.entry.fullPath);
              setContextMenu(null);
            }}
            sx={{ fontSize: '0.8rem' }}
          >
            <ListItemText>Open with VS Code</ListItemText>
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            if (contextMenu) window.electron?.openPath(contextMenu.entry.fullPath);
            setContextMenu(null);
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Open with Default App</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
};

// --- TreeNodeRow ---

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  path: string[];
  onToggle: (path: string[]) => void;
  onFileClick: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}

const TreeNodeRow: React.FC<TreeNodeRowProps> = ({ node, depth, path, onToggle, onFileClick, onContextMenu }) => {
  const isDir = node.entry.type === 'directory';

  const handleClick = () => {
    if (isDir) {
      onToggle(path);
    } else {
      onFileClick(node.entry);
    }
  };

  return (
    <>
      <Box
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node.entry)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          height: 26,
          pl: 1 + depth * 1.5,
          pr: 1,
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': {
            bgcolor: 'action.hover',
          },
          transition: 'background-color 100ms ease',
        }}
      >
        {/* Expand/collapse chevron for directories */}
        <Box sx={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {isDir && !node.isLoading && (
            node.isExpanded
              ? <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
              : <ChevronRightIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          )}
          {isDir && node.isLoading && (
            <CircularProgress size={12} sx={{ color: 'text.secondary' }} />
          )}
        </Box>

        {/* File icon */}
        <Box sx={{ display: 'flex', alignItems: 'center', mr: 0.75, flexShrink: 0 }}>
          {getFileIcon(node.entry.name, node.entry.type, node.isExpanded)}
        </Box>

        {/* File name */}
        <Tooltip title={node.entry.name} enterDelay={600} placement="right">
          <Typography
            variant="body2"
            noWrap
            sx={{
              fontSize: '0.8rem',
              color: 'text.primary',
              flex: 1,
              minWidth: 0,
            }}
          >
            {node.entry.name}
          </Typography>
        </Tooltip>
      </Box>

      {/* Children */}
      {isDir && node.isExpanded && node.children.map((child, i) => (
        <TreeNodeRow
          key={child.entry.fullPath}
          node={child}
          depth={depth + 1}
          path={[...path, String(i)]}
          onToggle={onToggle}
          onFileClick={onFileClick}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
};

// --- Helpers ---

function deepCloneNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) => ({
    ...n,
    children: deepCloneNodes(n.children),
  }));
}

function findNode(nodes: TreeNode[], path: string[]): TreeNode | null {
  if (path.length === 0) return null;
  const idx = parseInt(path[0], 10);
  if (idx < 0 || idx >= nodes.length) return null;
  if (path.length === 1) return nodes[idx];
  return findNode(nodes[idx].children, path.slice(1));
}
