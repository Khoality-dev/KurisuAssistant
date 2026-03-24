import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography, Button } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  InsertDriveFileOutlined as FileIcon,
  WarningAmber as WarningIcon,
} from '@mui/icons-material';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import { useExplorerStore } from '../../store/explorerStore';

export const FileEditor: React.FC = () => {
  const theme = useTheme();
  const diffReview = useExplorerStore((s) => s.diffReview);
  const isDark = theme.palette.mode === 'dark';
  const { openFiles, activeFileIndex, updateFileContent, saveFile } = useExplorerStore();
  const editorRef = useRef<any>(null);

  const activeFile = activeFileIndex >= 0 ? openFiles[activeFileIndex] : null;

  // Register Ctrl+S save handler
  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    // Auto-set live selection when editor loses focus
    editor.onDidBlurEditorText(() => {
      const sel = editor.getSelection();
      const { openFiles: files, activeFileIndex: idx, setLiveSelections } = useExplorerStore.getState();
      const file = idx >= 0 ? files[idx] : null;
      if (!file) return;

      if (!sel || sel.isEmpty()) {
        const model = editor.getModel();
        const totalLines = model?.getLineCount() || 0;
        setLiveSelections([{
          filePath: file.path,
          fileName: file.name,
          startLine: 1,
          endLine: totalLines,
          startColumn: 1,
          endColumn: 1,
          isWholeFile: true,
        }]);
      } else {
        setLiveSelections([{
          filePath: file.path,
          fileName: file.name,
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
          startColumn: sel.startColumn,
          endColumn: sel.endColumn,
          isWholeFile: false,
        }]);
      }
    });

    // "Add Selection to Chat" action — Ctrl+Shift+L or context menu
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
    };

    editor.addAction({
      id: 'add-to-chat',
      label: 'Add Selection to Chat',
      keybindings: [
        62, // F3
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

  // Diff review mode — agent wants to edit a file
  if (diffReview) {
    const handleDiffResponse = (accepted: boolean) => {
      window.electron?.hostTools?.sendDiffResult(diffReview.reviewId, accepted);
      // Defer unmount so Monaco can clean up its models first
      setTimeout(() => useExplorerStore.setState({ diffReview: null }), 0);
    };

    // Detect language from file extension
    const ext = diffReview.fileName.split('.').pop() || '';
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', rs: 'rust', go: 'go', java: 'java', json: 'json',
      html: 'html', css: 'css', scss: 'scss', md: 'markdown', yml: 'yaml', yaml: 'yaml',
      sh: 'shell', bash: 'shell', sql: 'sql', xml: 'xml', c: 'c', cpp: 'cpp', h: 'cpp',
    };
    const language = langMap[ext] || 'plaintext';

    return (
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{
          px: 2, py: 1, borderBottom: 1, borderColor: 'divider',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Review edit: {diffReview.fileName}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" color="error" onClick={() => handleDiffResponse(false)}>
              Reject
            </Button>
            <Button size="small" variant="contained" color="success" onClick={() => handleDiffResponse(true)}>
              Accept
            </Button>
          </Box>
        </Box>
        <Box sx={{ flex: 1 }}>
          <DiffEditor
            original={diffReview.originalContent}
            modified={diffReview.modifiedContent}
            language={language}
            theme={isDark ? 'vs-dark' : 'light'}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              lineHeight: 20,
              automaticLayout: true,
            }}
          />
        </Box>
      </Box>
    );
  }

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
