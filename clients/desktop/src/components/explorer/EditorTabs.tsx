import React, { useCallback } from 'react';
import { Box, Typography, IconButton, Tooltip } from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useExplorerStore } from '../../store/explorerStore';
import { getFileIcon } from './FileIcon';

export const EditorTabs: React.FC = () => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { openFiles, activeFileIndex, setActiveFile, closeFile } = useExplorerStore();

  const handleClose = useCallback((e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    closeFile(index);
  }, [closeFile]);

  const handleMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    // Middle-click to close
    if (e.button === 1) {
      e.preventDefault();
      closeFile(index);
    }
  }, [closeFile]);

  if (openFiles.length === 0) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        height: 36,
        flexShrink: 0,
        bgcolor: isDark ? '#0F0F0F' : '#F0F0F0',
        borderBottom: 1,
        borderColor: 'divider',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'stretch',
          overflow: 'auto',
          flex: 1,
          '&::-webkit-scrollbar': { height: 0 },
        }}
      >
        {openFiles.map((file, index) => {
          const isActive = index === activeFileIndex;
          const isDirty = file.content !== file.originalContent;

          return (
            <Tooltip key={file.path} title={file.path} enterDelay={400} placement="bottom">
            <Box
              onClick={() => setActiveFile(index)}
              onMouseDown={(e) => handleMouseDown(e, index)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1.5,
                height: '100%',
                cursor: 'pointer',
                userSelect: 'none',
                minWidth: 0,
                maxWidth: 180,
                flexShrink: 0,
                bgcolor: isActive
                  ? (isDark ? '#141414' : '#FFFFFF')
                  : 'transparent',
                borderRight: 1,
                borderColor: 'divider',
                position: 'relative',
                '&:hover': {
                  bgcolor: isActive
                    ? (isDark ? '#141414' : '#FFFFFF')
                    : 'action.hover',
                },
                // Active tab indicator line at bottom
                ...(isActive && {
                  '&::after': {
                    content: '""',
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    bgcolor: 'info.main',
                  },
                }),
                transition: 'background-color 100ms ease',
              }}
            >
              {/* Dirty indicator */}
              {isDirty && (
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    bgcolor: 'text.secondary',
                    flexShrink: 0,
                  }}
                />
              )}

              {/* File icon */}
              <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                {getFileIcon(file.name, 'file')}
              </Box>

              {/* File name */}
              <Typography
                variant="body2"
                noWrap
                sx={{
                  fontSize: '0.75rem',
                  color: isActive ? 'text.primary' : 'text.secondary',
                  fontWeight: isActive ? 500 : 400,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {file.name}
              </Typography>

              {/* Close button */}
              <IconButton
                size="small"
                onClick={(e) => handleClose(e, index)}
                sx={{
                  p: 0.25,
                  ml: 0.25,
                  flexShrink: 0,
                  opacity: 0,
                  '.MuiBox-root:hover > &': { opacity: 1 },
                  ...(isActive && { opacity: 0.6 }),
                  '&:hover': { opacity: 1, bgcolor: 'action.hover' },
                  transition: 'opacity 100ms ease',
                }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
            </Tooltip>
          );
        })}
      </Box>
    </Box>
  );
};
