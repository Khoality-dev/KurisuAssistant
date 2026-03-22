import React, { useCallback, useEffect, useState } from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';
import {
  ChevronRight as ChevronRightIcon,
  ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { ResizeHandle } from '../layout/ResizeHandle';
import { useLayoutStore } from '../../store/layoutStore';
import { useAgentStore } from '../../store/agentStore';
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
  const { explorerTreeWidth, setExplorerTreeWidth } = useLayoutStore();
  const agentId = useAgentStore((s) => s.selectedAgentId);
  const { openFile } = useExplorerStore();

  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [allowedPaths, setAllowedPaths] = useState<string[]>([]);
  const [isLoadingRoots, setIsLoadingRoots] = useState(false);

  // Load allowed paths and build root nodes
  useEffect(() => {
    if (agentId === null) {
      setRootNodes([]);
      setAllowedPaths([]);
      return;
    }

    let cancelled = false;
    setIsLoadingRoots(true);

    window.electron.hostTools.getAllowedPaths(agentId).then((paths: string[]) => {
      if (cancelled) return;
      setAllowedPaths(paths);

      // Build root tree nodes from allowed paths
      const nodes: TreeNode[] = paths.map((p) => {
        // Extract folder name from path
        const segments = p.replace(/[\\/]+$/, '').split(/[\\/]/);
        const name = segments[segments.length - 1] || p;
        return {
          entry: {
            name,
            fullPath: p,
            type: 'directory' as const,
            size: 0,
            modified: null,
            extension: '',
          },
          children: [],
          isExpanded: false,
          isLoaded: false,
          isLoading: false,
        };
      });
      setRootNodes(nodes);
      setIsLoadingRoots(false);
    }).catch(() => {
      if (!cancelled) setIsLoadingRoots(false);
    });

    return () => { cancelled = true; };
  }, [agentId]);

  // Toggle expand/collapse for a folder node
  const toggleExpand = useCallback(async (nodePath: string[]) => {
    if (agentId === null) return;

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
      window.electron.hostTools.listDirectory(target.entry.fullPath, agentId).then((result) => {
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
  }, [agentId]);

  const handleResize = useCallback((delta: number) => {
    setExplorerTreeWidth(Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, explorerTreeWidth + delta)));
  }, [explorerTreeWidth, setExplorerTreeWidth]);

  const handleFileClick = useCallback((entry: FileEntry) => {
    if (agentId === null) return;
    openFile(entry, agentId);
  }, [agentId, openFile]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'row', height: '100%', flexShrink: 0 }}>
      <Box
        sx={{
          width: explorerTreeWidth,
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
          {agentId === null && (
            <Box sx={{ px: 2, py: 3 }}>
              <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>
                Select an agent to browse files
              </Typography>
            </Box>
          )}

          {agentId !== null && isLoadingRoots && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={20} />
            </Box>
          )}

          {agentId !== null && !isLoadingRoots && allowedPaths.length === 0 && (
            <Box sx={{ px: 2, py: 3 }}>
              <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '0.8rem', lineHeight: 1.5 }}>
                Configure allowed paths in Settings &gt; Host Access
              </Typography>
            </Box>
          )}

          {agentId !== null && !isLoadingRoots && rootNodes.map((node, i) => (
            <TreeNodeRow
              key={node.entry.fullPath}
              node={node}
              depth={0}
              path={[String(i)]}
              onToggle={toggleExpand}
              onFileClick={handleFileClick}
            />
          ))}
        </Box>
      </Box>

      <ResizeHandle onResize={handleResize} />
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
}

const TreeNodeRow: React.FC<TreeNodeRowProps> = ({ node, depth, path, onToggle, onFileClick }) => {
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
