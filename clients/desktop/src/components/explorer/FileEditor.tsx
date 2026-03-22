import React, { useCallback, useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  InsertDriveFileOutlined as FileIcon,
} from '@mui/icons-material';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useExplorerStore, isImageFile } from '../../store/explorerStore';
import { Button } from '@mui/material';
import { WarningAmber as WarningIcon } from '@mui/icons-material';

export const FileEditor: React.FC = () => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { openFiles, activeFileIndex, updateFileContent, saveFile } = useExplorerStore();
  const editorRef = useRef<any>(null);

  const activeFile = activeFileIndex >= 0 ? openFiles[activeFileIndex] : null;

  // Register Ctrl+S save handler
  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    editor.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [
        // Monaco KeyMod.CtrlCmd | KeyCode.KeyS
        2048 | 49, // CtrlCmd + S
      ],
      run: () => {
        const { activeFileIndex: idx } = useExplorerStore.getState();
        if (idx >= 0) {
          saveFile(idx);
        }
      },
    });
  }, [saveFile]);

  const handleContentChange = useCallback((value: string | undefined) => {
    if (value !== undefined && activeFileIndex >= 0) {
      updateFileContent(activeFileIndex, value);
    }
  }, [activeFileIndex, updateFileContent]);

  // Suppress default browser Ctrl+S when editor is not focused
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const { activeFileIndex: idx } = useExplorerStore.getState();
        if (idx >= 0) {
          saveFile(idx);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveFile]);

  // Empty state
  if (!activeFile) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          color: 'text.secondary',
          opacity: 0.5,
        }}
      >
        <FileIcon sx={{ fontSize: 48 }} />
        <Typography variant="body2" sx={{ fontSize: '0.85rem' }}>
          Open a file from the explorer
        </Typography>
        <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
          Ctrl+S to save
        </Typography>
      </Box>
    );
  }

  // Image preview
  if (isImageFile(activeFile.name)) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
          bgcolor: isDark ? '#0A0A0A' : '#FAFAFA',
          p: 2,
        }}
      >
        <Box
          component="img"
          src={`file:///${activeFile.path.replace(/\\/g, '/')}`}
          alt={activeFile.name}
          sx={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            borderRadius: 1,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          }}
        />
      </Box>
    );
  }

  // Binary file prompt
  if (activeFile.isBinary && !activeFile.forceOpen) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          color: 'text.secondary',
        }}
      >
        <WarningIcon sx={{ fontSize: 48, opacity: 0.4 }} />
        <Typography variant="body2" sx={{ fontSize: '0.9rem', fontWeight: 500 }}>
          The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.
        </Typography>
        <Button
          variant="outlined"
          size="small"
          onClick={() => useExplorerStore.getState().forceOpenBinary(activeFileIndex)}
        >
          Open Anyway
        </Button>
      </Box>
    );
  }

  // Monaco editor
  return (
    <Box sx={{ flex: 1, overflow: 'hidden' }}>
      <Editor
        key={activeFile.path}
        defaultValue={activeFile.content}
        language={activeFile.language}
        theme={isDark ? 'vs-dark' : 'light'}
        onChange={handleContentChange}
        onMount={handleEditorMount}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 20,
          padding: { top: 12 },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          renderLineHighlight: 'line',
          smoothScrolling: true,
          cursorSmoothCaretAnimation: 'on',
          bracketPairColorization: { enabled: true },
          automaticLayout: true,
          unusualLineTerminators: 'auto',
        }}
      />
    </Box>
  );
};
