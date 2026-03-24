/**
 * Reusable search panel — search bar + VS Code-style grouped results.
 * Used by both FullExplorer and FileTreeSidebar.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  IconButton,
  Tooltip,
  CircularProgress,
  InputAdornment,
} from '@mui/material';
import {
  Search as SearchIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { getFileIcon } from './FileIcon';

// --- Highlight component ---

export const Highlight: React.FC<{ text: string; query: string; caseSensitive?: boolean }> = ({ text, query, caseSensitive = false }) => {
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

// --- Types ---

interface SearchResults {
  names: Array<{ path: string; name: string; type: 'file' | 'directory' }>;
  matches: Array<{ path: string; line: number; snippet: string }>;
}

interface SearchPanelProps {
  /** Directory to search in */
  searchRoot: string;
  /** Called when user clicks a file result */
  onOpenFile: (fullPath: string, name: string) => void;
  /** Called when user clicks a directory result */
  onOpenDirectory: (fullPath: string) => void;
  /** Compact mode for narrow sidebar */
  compact?: boolean;
  /** Show the search bar (controlled) */
  visible: boolean;
  /** Called when user closes the search */
  onClose: () => void;
  /** Ref to focus the search input externally */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Show toggle buttons for case/whole word */
  showToggles?: boolean;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({
  searchRoot,
  onOpenFile,
  onOpenDirectory,
  compact = false,
  visible,
  onClose,
  inputRef: externalInputRef,
  showToggles = true,
}) => {
  const [filterText, setFilterText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentCleanupRef = useRef<Array<() => void>>([]);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef || internalInputRef;

  const cancelSearch = useCallback(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    window.electron?.explorer?.searchContentCancel?.();
    contentCleanupRef.current.forEach((fn) => fn());
    contentCleanupRef.current = [];
  }, []);

  const runSearch = useCallback((query: string) => {
    cancelSearch();
    if (!query.trim() || !searchRoot || !window.electron?.explorer) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    setSearchResults({ names: [], matches: [] });
    setCollapsedFiles(new Set());

    searchTimerRef.current = setTimeout(async () => {
      const q = query.trim();
      const opts = { caseSensitive, wholeWord };

      // Phase 1: name matches
      try {
        const names = await window.electron.explorer.searchNames(q, searchRoot, opts);
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
      window.electron.explorer.searchContentStart(q, searchRoot, opts);
    }, 300);
  }, [searchRoot, caseSensitive, wholeWord, cancelSearch]);

  // Clean up on unmount
  useEffect(() => () => cancelSearch(), [cancelSearch]);

  // Re-run search when toggles change (if there's an active query)
  useEffect(() => {
    if (filterText.trim()) runSearch(filterText);
  }, [caseSensitive, wholeWord]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    setFilterText('');
    setSearchResults(null);
    setIsSearching(false);
    cancelSearch();
    onClose();
  };

  if (!visible) return null;

  // --- Grouped results ---
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

  const fontSize = compact ? '0.7rem' : '0.8rem';
  const snippetFontSize = compact ? '0.65rem' : '0.75rem';
  const rowHeight = compact ? 24 : 28;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: searchResults !== null ? 1 : undefined }}>
      {/* Search bar */}
      <Box sx={{ px: compact ? 0.5 : 1, py: 0.5, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 0.25 }}>
        <TextField
          inputRef={inputRef}
          size="small"
          fullWidth
          placeholder="Search"
          value={filterText}
          autoFocus
          onChange={(e) => {
            setFilterText(e.target.value);
            runSearch(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') handleClose();
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: compact ? 14 : 16, color: 'text.secondary' }} />
                </InputAdornment>
              ),
              endAdornment: filterText ? (
                <InputAdornment position="end">
                  {isSearching ? (
                    <CircularProgress size={compact ? 12 : 14} />
                  ) : (
                    <IconButton size="small" onClick={handleClose} sx={{ p: 0.25 }}>
                      <CloseIcon sx={{ fontSize: compact ? 12 : 14 }} />
                    </IconButton>
                  )}
                </InputAdornment>
              ) : undefined,
            },
          }}
          sx={{
            '& .MuiInputBase-input': { fontSize: compact ? '0.75rem' : '0.8rem', py: compact ? 0.25 : 0.5 },
            '& .MuiOutlinedInput-root': { pr: filterText ? 0.5 : 1 },
          }}
        />
        {showToggles && (
          <>
            <Tooltip title="Match Case">
              <IconButton
                size="small"
                onClick={() => setCaseSensitive((v) => !v)}
                sx={{
                  fontSize: '0.75rem', fontWeight: 700, width: 24, height: 24,
                  color: caseSensitive ? 'primary.main' : 'text.disabled',
                  border: 1, borderColor: caseSensitive ? 'primary.main' : 'transparent',
                  borderRadius: 0.5, flexShrink: 0,
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
                  borderRadius: 0.5, flexShrink: 0,
                }}
              >
                W
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>

      {/* Results */}
      {searchResults !== null && (
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {/* Summary */}
          {hasResults && !compact && (
            <Box sx={{ px: 2, py: 0.5, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {totalContentMatches} result{totalContentMatches !== 1 ? 's' : ''} in {totalFiles} file{totalFiles !== 1 ? 's' : ''}
                {nameOnlyMatches.length > 0 ? ` + ${nameOnlyMatches.length} name match${nameOnlyMatches.length !== 1 ? 'es' : ''}` : ''}
              </Typography>
              {isSearching && <CircularProgress size={12} />}
            </Box>
          )}

          {/* Spinner for compact mode */}
          {compact && isSearching && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
              <CircularProgress size={16} />
            </Box>
          )}

          {!hasResults && !isSearching && (
            <Typography sx={{ textAlign: 'center', py: compact ? 3 : 4, color: 'text.secondary', fontSize: compact ? '0.75rem' : '0.85rem' }}>
              {isSearching ? 'Searching...' : 'No results found.'}
            </Typography>
          )}

          {/* Name-only matches */}
          {nameOnlyMatches.map((item, i) => {
            const relativePath = item.path.startsWith(searchRoot)
              ? item.path.substring(searchRoot.length).replace(/^[\\/]/, '')
              : item.path;
            return (
              <Box
                key={`name-${i}`}
                onClick={() => item.type === 'directory' ? onOpenDirectory(item.path) : onOpenFile(item.path, item.name)}
                sx={{
                  display: 'flex', alignItems: 'center', height: rowHeight, px: compact ? 1 : 1.5, gap: compact ? 0.5 : 1,
                  cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                {getFileIcon(item.name, item.type === 'directory')}
                <Typography variant="body2" noWrap sx={{ fontSize, flex: 1 }}>
                  {compact ? item.name : <Highlight text={relativePath} query={filterText} caseSensitive={caseSensitive} />}
                </Typography>
              </Box>
            );
          })}

          {/* Content matches grouped by file */}
          {Array.from(contentByFile.entries()).map(([filePath, matches]) => {
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            const relDir = filePath.startsWith(searchRoot)
              ? filePath.substring(searchRoot.length).replace(/^[\\/]/, '').replace(/[\\/][^\\/]+$/, '')
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
                    display: 'flex', alignItems: 'center', height: rowHeight,
                    px: compact ? 0.5 : 1, gap: compact ? 0.25 : 0.5,
                    cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
                    position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1,
                  }}
                >
                  <Typography sx={{ fontSize: compact ? '0.6rem' : '0.7rem', color: 'text.secondary', width: 12, textAlign: 'center', userSelect: 'none' }}>
                    {isCollapsed ? '>' : 'v'}
                  </Typography>
                  {getFileIcon(fileName, false)}
                  <Typography variant="body2" noWrap sx={{ fontWeight: 600, fontSize, flex: 1 }}>
                    {nameMatched ? <Highlight text={fileName} query={filterText} caseSensitive={caseSensitive} /> : fileName}
                  </Typography>
                  {!compact && relDir && (
                    <Typography variant="caption" noWrap color="text.secondary" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {relDir}
                    </Typography>
                  )}
                  <Box sx={{
                    bgcolor: 'action.selected', borderRadius: 3, px: 0.75, minWidth: 18,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Typography variant="caption" sx={{ fontSize: compact ? '0.6rem' : '0.7rem', fontWeight: 600 }}>
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
                      onClick={() => onOpenFile(filePath, fileName)}
                      sx={{
                        display: 'flex', alignItems: 'baseline', height: compact ? 20 : 24,
                        pl: compact ? 3 : 4.5, pr: compact ? 0.5 : 1.5, gap: 0.5,
                        cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' }, overflow: 'hidden',
                      }}
                    >
                      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, width: compact ? 24 : 32, textAlign: 'right', fontSize: compact ? '0.6rem' : '0.7rem' }}>
                        {match.line}
                      </Typography>
                      <Typography variant="caption" component="div" noWrap sx={{
                        fontFamily: 'monospace', fontSize: snippetFontSize, color: 'text.secondary', flex: 1,
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
      )}
    </Box>
  );
};
