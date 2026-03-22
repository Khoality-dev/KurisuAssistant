import React, { useCallback, useEffect, useState } from 'react';
import { Box, Typography, CircularProgress, Menu, MenuItem, ListItemText } from '@mui/material';
import {
  ChevronRight as ChevronRightIcon,
  ExpandMore as ExpandMoreIcon,
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
  const { workspaceTreeWidth, setWorkspaceTreeWidth } = useLayoutStore();
  const { openFile } = useExplorerStore();

  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [isLoadingRoots, setIsLoadingRoots] = useState(true);
  const [hasVSCode, setHasVSCode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; entry: FileEntry } | null>(null);

  useEffect(() => {
    window.electron?.explorer?.hasVSCode?.().then(setHasVSCode).catch(() => {});
  }, []);

  // Load root filesystem entries (drives on Windows, home+/ on Linux)
  useEffect(() => {
    if (!window.electron?.hostTools) {
      setIsLoadingRoots(false);
      return;
    }

    window.electron.explorer.listDirectory('').then((result) => {
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
  }, []);

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

  const handleResize = useCallback((delta: number) => {
    setWorkspaceTreeWidth(Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, workspaceTreeWidth + delta)));
  }, [workspaceTreeWidth, setWorkspaceTreeWidth]);

  const handleFileClick = useCallback((entry: FileEntry) => {
    openFile(entry);
  }, [openFile]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY, entry });
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'row', height: '100%', flexShrink: 0 }}>
      <Box
        sx={{
          width: workspaceTreeWidth,
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
            px: 2,
            py: 1.5,
            flexShrink: 0,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Typography
            variant="caption"
            sx={{
              fontWeight: 700,
              fontSize: '0.65rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'text.secondary',
            }}
          >
            Explorer
          </Typography>
        </Box>

        {/* Tree content */}
        <Box sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
          {isLoadingRoots && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={20} />
            </Box>
          )}

          {!isLoadingRoots && rootNodes.map((node, i) => (
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

      <ResizeHandle onResize={handleResize} />

      {/* Context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
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
