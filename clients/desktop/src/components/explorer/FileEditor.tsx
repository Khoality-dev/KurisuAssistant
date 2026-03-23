import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography, Fab, Tooltip as MuiTooltip } from '@mui/material';
import { AddComment as AddChatIcon } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import {
  InsertDriveFileOutlined as FileIcon,
} from '@mui/icons-material';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useExplorerStore } from '../../store/explorerStore';
import { Button } from '@mui/material';
import { WarningAmber as WarningIcon } from '@mui/icons-material';

export const FileEditor: React.FC = () => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { openFiles, activeFileIndex, updateFileContent, saveFile } = useExplorerStore();
  const editorRef = useRef<any>(null);
  const addToChatRef = useRef<(() => void) | null>(null);
  const [floatingBtn, setFloatingBtn] = useState<{ x: number; y: number } | null>(null);

  const activeFile = activeFileIndex >= 0 ? openFiles[activeFileIndex] : null;

  // Register Ctrl+S save handler
  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    // Show/hide floating "Add to Chat" button on selection change
    editor.onDidChangeCursorSelection(() => {
      const sel = editor.getSelection();
      if (!sel || sel.isEmpty()) {
        setFloatingBtn(null);
        return;
      }
      // Position the button near the end of the selection
      const endPos = sel.getEndPosition();
      const coords = editor.getScrolledVisiblePosition(endPos);
      const editorDom = editor.getDomNode();
      if (coords && editorDom) {
        const rect = editorDom.getBoundingClientRect();
        setFloatingBtn({ x: rect.left + coords.left + 20, y: rect.top + coords.top - 40 });
      }
    });

    // "Add Selection to Chat" action — Ctrl+Shift+L or context menu or floating button
    const addSelectionToChat = () => {
      const sel = editor.getSelection();
      const { openFiles: files, activeFileIndex: idx, addSelection: add } = useExplorerStore.getState();
      const file = idx >= 0 ? files[idx] : null;
      if (!file || !sel || sel.isEmpty()) return;
      const model = editor.getModel();
      const text = model?.getValueInRange(sel) || '';
      if (!text.trim()) return;
      add({
        filePath: file.path,
        fileName: file.name,
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
        startColumn: sel.startColumn,
        endColumn: sel.endColumn,
        text,
      });
      setFloatingBtn(null);
    };
    addToChatRef.current = addSelectionToChat;

    editor.addAction({
      id: 'add-to-chat',
      label: 'Add Selection to Chat',
      keybindings: [
        2048 | 1024 | 42, // CtrlCmd + Shift + L
      ],
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 10,
      run: addSelectionToChat,
    });

    // Check for pending reveal (from clicking a selection chip)
    const reveal = useExplorerStore.getState().revealSelection;
    if (reveal) {
      const { openFiles: files, activeFileIndex: idx } = useExplorerStore.getState();
      const file = idx >= 0 ? files[idx] : null;
      if (file && reveal.filePath === file.path) {
        setTimeout(() => {
          editor.revealLineInCenter(reveal.startLine);
          editor.setSelection({
            startLineNumber: reveal.startLine,
            startColumn: reveal.startColumn,
            endLineNumber: reveal.endLine,
            endColumn: reveal.endColumn,
          });
          editor.focus();
        }, 50);
        useExplorerStore.setState({ revealSelection: null });
      }
    }

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

  // Error state
  if (activeFile.error) {
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
        <WarningIcon sx={{ fontSize: 48, color: 'error.main', opacity: 0.6 }} />
        <Typography variant="body2" sx={{ fontSize: '0.9rem', fontWeight: 500 }}>
          Failed to open file
        </Typography>
        <Typography variant="caption" sx={{ maxWidth: 400, textAlign: 'center', wordBreak: 'break-all' }}>
          {activeFile.error}
        </Typography>
      </Box>
    );
  }

  // Binary file — try image preview first, fallback to "Open Anyway"
  if (activeFile.isBinary && !activeFile.forceOpen) {
    return <BinaryFileView file={activeFile} fileIndex={activeFileIndex} isDark={isDark} />;
  }

  // Monaco editor
  return (
    <Box sx={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
      {/* Floating "Add to Chat" button */}
      {floatingBtn && (
        <MuiTooltip title="Add selection to chat (Ctrl+Shift+L)" placement="top">
          <Fab
            size="small"
            onClick={() => addToChatRef.current?.()}
            sx={{
              position: 'fixed',
              left: floatingBtn.x,
              top: floatingBtn.y,
              zIndex: 1000,
              width: 28,
              height: 28,
              minHeight: 28,
              bgcolor: 'info.main',
              color: '#fff',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              '&:hover': { bgcolor: 'info.dark' },
            }}
          >
            <AddChatIcon sx={{ fontSize: 16 }} />
          </Fab>
        </MuiTooltip>
      )}
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

// --- Binary file handler: try image, fallback to prompt ---

const BinaryFileView: React.FC<{
  file: { path: string; name: string };
  fileIndex: number;
  isDark: boolean;
}> = ({ file, fileIndex, isDark }) => {
  const [imageError, setImageError] = useState(false);
  const imgSrc = `local-file:///${file.path.replace(/\\/g, '/')}`;

  if (!imageError) {
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
          src={imgSrc}
          alt={file.name}
          onError={() => setImageError(true)}
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
        onClick={() => useExplorerStore.getState().forceOpenBinary(fileIndex)}
      >
        Open Anyway
      </Button>
    </Box>
  );
};
