import React from 'react';
import { Box, Chip, Tooltip } from '@mui/material';
import { useExplorerStore } from '../../store/explorerStore';
import { useLayoutStore } from '../../store/layoutStore';

export const SelectionChips: React.FC = () => {
  const selections = useExplorerStore((s) => s.selections);
  const liveSelections = useExplorerStore((s) => s.liveSelections);
  const removeSelection = useExplorerStore((s) => s.removeSelection);
  const setLiveSelections = useExplorerStore((s) => s.setLiveSelections);

  // Filter out live selections that overlap with pinned ones
  const pinnedPaths = new Set(selections.map(s => `${s.filePath}:${s.startLine}-${s.endLine}`));
  const filteredLive = liveSelections.filter(ls => {
    const key = ls.isWholeFile ? `${ls.filePath}:0-0` : `${ls.filePath}:${ls.startLine}-${ls.endLine}`;
    return !pinnedPaths.has(key);
  });

  if (selections.length === 0 && filteredLive.length === 0) return null;

  const handlePinnedClick = async (sel: typeof selections[number]) => {
    const store = useExplorerStore.getState();
    const idx = store.openFiles.findIndex(f => f.path === sel.filePath);
    if (idx !== -1) {
      store.setActiveFile(idx);
    } else {
      // Open the file first
      await store.openFile({
        name: sel.fileName,
        fullPath: sel.filePath,
        type: 'file',
        size: 0,
        modified: null,
        extension: '',
      });
    }
    if (sel.startLine > 0) {
      useExplorerStore.setState({ revealSelection: sel });
    }
    useLayoutStore.getState().setActivePage('workspace');
  };

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, py: 0.75, flexShrink: 0 }}>
      {/* Live selections — dashed outline, auto-replaced */}
      {filteredLive.map((ls, i) => (
        <Tooltip key={`live-${i}`} title={ls.isWholeFile ? ls.filePath : `${ls.filePath}:${ls.startLine}:${ls.startColumn}-${ls.endLine}:${ls.endColumn}`}
          placement="top" enterDelay={300}
        >
        <Chip
          label={ls.isWholeFile ? ls.fileName : `${ls.fileName}:${ls.startLine}:${ls.startColumn}-${ls.endLine}:${ls.endColumn}`}
          size="small"
          variant="outlined"
          color="info"
          onDelete={() => setLiveSelections(liveSelections.filter(x => x !== ls))}
          sx={{
            fontSize: '0.8rem',
            height: 28,
            borderRadius: 1,
            borderStyle: 'dashed',
            '& .MuiChip-deleteIcon': { fontSize: 14 },
          }}
        />
        </Tooltip>
      ))}
      {/* Pinned selections — solid */}
      {selections.map((sel) => (
        <Tooltip key={sel.id} title={sel.startLine > 0 ? `${sel.filePath}:${sel.startLine}:${sel.startColumn}-${sel.endLine}:${sel.endColumn}` : sel.filePath} placement="top" enterDelay={300}>
        <Chip
          label={sel.startLine > 0 ? `${sel.fileName}:${sel.startLine}:${sel.startColumn}-${sel.endLine}:${sel.endColumn}` : sel.fileName}
          size="small"
          onClick={() => handlePinnedClick(sel)}
          onDelete={() => removeSelection(sel.id)}
          sx={{
            fontSize: '0.8rem',
            height: 28,
            borderRadius: 1,
            cursor: 'pointer',
            '& .MuiChip-deleteIcon': { fontSize: 14 },
          }}
        />
        </Tooltip>
      ))}
    </Box>
  );
};
