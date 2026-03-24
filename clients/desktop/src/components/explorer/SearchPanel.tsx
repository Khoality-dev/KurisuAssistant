/**
 * SearchBar — reusable search input with case-sensitive and whole-word toggles.
 * Also re-exports the Highlight component for use in search results.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
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

// --- SearchBar component ---

interface SearchBarProps {
  /** Ref to focus the search input externally */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Compact mode for narrow sidebar */
  compact?: boolean;
  /** Whether the search bar is visible */
  visible: boolean;
  /** Called when user presses Escape or clicks clear */
  onClose: () => void;
  /** Debounced search callback (300ms) */
  onSearch: (query: string, opts: { caseSensitive: boolean; wholeWord: boolean }) => void;
  /** Whether a search is currently in progress (shows spinner) */
  searching?: boolean;
  /** Inline mode — no padding or border (for embedding in a toolbar) */
  inline?: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  inputRef: externalInputRef,
  compact = false,
  visible,
  onClose,
  onSearch,
  searching = false,
  inline = false,
}) => {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef || internalInputRef;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fireSearch = useCallback((q: string, cs: boolean, ww: boolean) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearch(q, { caseSensitive: cs, wholeWord: ww });
    }, 300);
  }, [onSearch]);

  // Clean up debounce on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // When toggles change, re-fire with current query
  useEffect(() => {
    if (query.trim()) {
      fireSearch(query, caseSensitive, wholeWord);
    }
  }, [caseSensitive, wholeWord]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    setQuery('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onSearch('', { caseSensitive, wholeWord });
    onClose();
  };

  if (!visible) return null;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, ...(inline ? {} : { px: compact ? 0.5 : 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }) }}>
      <TextField
        inputRef={inputRef}
        size="small"
        fullWidth
        placeholder="Search"
        value={query}
        autoFocus={!inline}
        onChange={(e) => {
          setQuery(e.target.value);
          fireSearch(e.target.value, caseSensitive, wholeWord);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') handleClose();
        }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon sx={{ fontSize: compact ? 14 : 16, color: 'text.secondary' }} />
            </InputAdornment>
          ),
          endAdornment: query ? (
            <InputAdornment position="end">
              {searching ? (
                <CircularProgress size={compact ? 12 : 14} />
              ) : (
                <IconButton size="small" onClick={handleClose} sx={{ p: 0.25 }}>
                  <CloseIcon sx={{ fontSize: compact ? 12 : 14 }} />
                </IconButton>
              )}
            </InputAdornment>
          ) : undefined,
        }}
        sx={{
          '& .MuiInputBase-input': { fontSize: compact ? '0.75rem' : '0.8rem', py: compact ? 0.25 : 0.5 },
          '& .MuiOutlinedInput-root': { pr: query ? 0.5 : 1 },
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
    </Box>
  );
};
