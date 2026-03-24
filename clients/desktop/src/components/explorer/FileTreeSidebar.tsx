import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography, CircularProgress, Menu, MenuItem, ListItemText, Tooltip, IconButton } from '@mui/material';
import {
  ChevronRight as ChevronRightIcon,
  ExpandMore as ExpandMoreIcon,
  ArrowUpward as UpIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { ResizeHandle } from '../layout/ResizeHandle';
import { useLayoutStore } from '../../store/layoutStore';
import { getFileIcon } from './FileIcon';
import { SearchBar, Highlight } from './SearchPanel';
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

// --- Search result types ---
interface SearchResults {
  names: Array<{ path: string; name: string; type: 'file' | 'directory' }>;
  matches: Array<{ path: string; line: number; snippet: string }>;
}

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
  const [showTreeFilter, setShowTreeFilter] = useState(false);
  const treeSearchRef = useRef<HTMLInputElement>(null);
  const contentCleanupRef = useRef<Array<() => void>>([]);

  // Search state
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);

  useEffect(() => {
    window.electron?.explorer?.hasVSCode?.().then(setHasVSCode).catch(() => {});
  }, []);

  // Ctrl+F focuses tree search when sidebar has focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        // Let Monaco handle its own Ctrl+F — only intercept if focus is
        // NOT inside a Monaco editor (which uses class 'monaco-editor')
        const active = document.activeElement;
        if (active?.closest('.monaco-editor')) return;

        e.preventDefault();
        setShowTreeFilter(true);
        setTimeout(() => {
          treeSearchRef.current?.focus();
          treeSearchRef.current?.select();
        }, 0);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const cancelSearch = useCallback(() => {
    window.electron?.explorer?.searchContentCancel?.();
    contentCleanupRef.current.forEach((fn) => fn());
    contentCleanupRef.current = [];
  }, []);

  // Clean up search on unmount
  useEffect(() => () => cancelSearch(), [cancelSearch]);

  const handleSearch = useCallback((query: string, opts: { caseSensitive: boolean; wholeWord: boolean }) => {
    cancelSearch();
    setSearchQuery(query);
    setSearchCaseSensitive(opts.caseSensitive);

    if (!query.trim() || !workspaceRoot || !window.electron?.explorer) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setSearchResults({ names: [], matches: [] });
    setCollapsedFiles(new Set());

    const q = query.trim();

    // Phase 1: name matches
    window.electron.explorer.searchNames(q, workspaceRoot, opts).then((names) => {
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
    window.electron.explorer.searchContentStart(q, workspaceRoot, opts);
  }, [workspaceRoot, cancelSearch]);

  const handleSearchClose = useCallback(() => {
    cancelSearch();
    setSearchResults(null);
    setIsSearching(false);
    setSearchQuery('');
    setShowTreeFilter(false);
  }, [cancelSearch]);

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

  // Grouped search results for compact rendering
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
  const hasSearchResults = nameOnlyMatches.length > 0 || (searchResults?.matches.length || 0) > 0;

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
                fontSize: '0.8rem',
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

        {/* Search bar */}
        <SearchBar
          inputRef={treeSearchRef}
          compact
          visible={showTreeFilter}
          onClose={handleSearchClose}
          onSearch={handleSearch}
          searching={isSearching}
        />

        {/* Tree content or search results */}
        <Box sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
          {searchActive ? (
            <>
              {isSearching && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
                  <CircularProgress size={16} />
                </Box>
              )}

              {!hasSearchResults && !isSearching && (
                <Typography sx={{ textAlign: 'center', py: 3, color: 'text.secondary', fontSize: '0.85rem' }}>
                  No results found
                </Typography>
              )}

              {/* Name-only matches */}
              {nameOnlyMatches.map((item, i) => (
                <Box
                  key={`name-${i}`}
                  onClick={() => item.type === 'directory'
                    ? useExplorerStore.setState({ workspaceRoot: item.path })
                    : openFile({ name: item.name, fullPath: item.path, type: 'file', size: 0, modified: null, extension: '' })
                  }
                  sx={{
                    display: 'flex', alignItems: 'center', height: 26, px: 1, gap: 0.75,
                    cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  {getFileIcon(item.name, item.type)}
                  <Typography variant="body2" noWrap sx={{ fontSize: '0.85rem', flex: 1 }}>
                    <Highlight text={item.name} query={searchQuery} caseSensitive={searchCaseSensitive} />
                  </Typography>
                </Box>
              ))}

              {/* Content matches grouped by file */}
              {Array.from(contentByFile.entries()).map(([filePath, matches]) => {
                const fileName = filePath.split(/[\\/]/).pop() || filePath;
                const isCollapsed = collapsedFiles.has(filePath);
                const nameMatched = searchResults?.names.some((n) => n.path === filePath);

                return (
                  <Box key={filePath}>
                    <Box
                      onClick={() => setCollapsedFiles((prev) => {
                        const next = new Set(prev);
                        next.has(filePath) ? next.delete(filePath) : next.add(filePath);
                        return next;
                      })}
                      sx={{
                        display: 'flex', alignItems: 'center', height: 26, px: 0.5, gap: 0.25,
                        cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
                      }}
                    >
                      <Typography sx={{ fontSize: '0.85rem', color: 'text.secondary', width: 10, textAlign: 'center' }}>
                        {isCollapsed ? '>' : 'v'}
                      </Typography>
                      {getFileIcon(fileName, 'file')}
                      <Typography variant="body2" noWrap sx={{ fontSize: '0.85rem', fontWeight: 600, flex: 1 }}>
                        {nameMatched ? <Highlight text={fileName} query={searchQuery} caseSensitive={searchCaseSensitive} /> : fileName}
                      </Typography>
                      <Typography variant="caption" sx={{ fontSize: '0.85rem', color: 'text.secondary', pr: 0.5 }}>
                        {matches.length}
                      </Typography>
                    </Box>
                    {!isCollapsed && matches.map((match, j) => {
                      let snippet = match.snippet;
                      const qi = (searchCaseSensitive ? snippet : snippet.toLowerCase()).indexOf(searchCaseSensitive ? searchQuery : searchQuery.toLowerCase());
                      if (qi > 30) snippet = '...' + snippet.substring(qi - 20);
                      if (snippet.length > 100) snippet = snippet.substring(0, 100) + '...';

                      return (
                        <Box
                          key={j}
                          onClick={() => openFile({
                            name: fileName, fullPath: filePath, type: 'file', size: 0, modified: null,
                            extension: fileName.includes('.') ? '.' + fileName.split('.').pop() : '',
                          })}
                          sx={{
                            display: 'flex', alignItems: 'baseline', height: 22, pl: 3, pr: 0.5, gap: 0.5,
                            cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' }, overflow: 'hidden',
                          }}
                        >
                          <Typography variant="caption" sx={{ fontSize: '0.8rem', color: 'text.secondary', flexShrink: 0, width: 28, textAlign: 'right' }}>
                            {match.line}
                          </Typography>
                          <Typography variant="caption" noWrap sx={{ fontSize: '0.8rem', fontFamily: 'monospace', color: 'text.secondary', flex: 1 }}>
                            <Highlight text={snippet} query={searchQuery} caseSensitive={searchCaseSensitive} />
                          </Typography>
                        </Box>
                      );
                    })}
                  </Box>
                );
              })}
            </>
          ) : (
            <>
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
            </>
          )}
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
