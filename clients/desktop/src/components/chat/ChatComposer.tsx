import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Box,
  TextField,
  Button,
  IconButton,
  Paper,
  Chip,
  Tooltip,
  MenuItem,
  ListItemText,
  Popper,
  Typography,
  ClickAwayListener,
} from '@mui/material';
import { getCommands } from '../../utils/commands';
import { useConversationStore } from '../../store/conversationStore';
import {
  Send as SendIcon,
  Close as CloseIcon,
  Stop as StopIcon,
  Mic as MicIcon,
} from '@mui/icons-material';
import { useMicStore, getMicAmplitude } from '../../store/micStore';

/** Mic icon that lights up when sound is detected */
const MicIndicator: React.FC = () => {
  const status = useMicStore((s) => s.status);
  const iconRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (status === 'idle') return;
    let raf = 0;
    let smoothed = 0;
    const update = () => {
      if (iconRef.current) {
        const raw = getMicAmplitude();
        // EMA smoothing: fast attack, slow decay
        smoothed += (raw - smoothed) * (raw > smoothed ? 0.3 : 0.08);
        const opacity = Math.min(1, smoothed / 0.15);
        iconRef.current.style.color = `rgba(76, 175, 80, ${opacity})`;
      }
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  if (status === 'idle') return null;

  return (
    <Tooltip title={status === 'processing' ? 'Processing...' : 'Listening'}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40 }}>
        <MicIcon
          ref={iconRef}
          sx={{ fontSize: 20, color: 'text.secondary' }}
        />
      </Box>
    </Tooltip>
  );
};

export interface ChatComposerProps {
  scopeKey: string;
  externalDraft: string;
  externalDraftVersion: number;
  isStreaming: boolean;
  onSend: (text: string, imageFiles: File[]) => Promise<void>;
  onCancel: () => void;
}

// Module-level prompt history — survives component re-renders and remounts
const promptHistory: string[] = [];

export const ChatComposer: React.FC<ChatComposerProps> = React.memo(({
  scopeKey,
  externalDraft,
  externalDraftVersion,
  isStreaming,
  onSend,
  onCancel,
}) => {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [commandIdx, setCommandIdx] = useState(-1);
  const [commandSelected, setCommandSelected] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const textFieldRef = useRef<HTMLDivElement>(null);

  // Prompt history (module-level so it survives component remounts)
  const historyIdxRef = useRef(-1); // -1 = not browsing history
  const draftRef = useRef(''); // saves current input when entering history

  const allCommands = useMemo(() => getCommands(), []);

  // Filter commands when input starts with /
  const filteredCommands = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const query = input.slice(1).toLowerCase();
    return allCommands.filter((c) => c.name.startsWith(query));
  }, [input, allCommands]);

  const showCommands = filteredCommands.length > 0 && !isStreaming && !commandSelected;

  useEffect(() => {
    setInput('');
    setImages([]);
    // Pre-populate prompt history from conversation's user messages
    promptHistory.length = 0;
    historyIdxRef.current = -1;
    const msgs = useConversationStore.getState().messages;
    for (const m of msgs) {
      if (m.role === 'user' && m.content) promptHistory.push(m.content);
    }
  }, [scopeKey]);

  useEffect(() => {
    setInput(externalDraft);
  }, [externalDraft, externalDraftVersion]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      setImages((prev) => [...prev, ...files]);
    }
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    // Save to prompt history
    promptHistory.push(text);
    historyIdxRef.current = -1;
    draftRef.current = '';
    const imageFiles = [...images];
    setInput('');
    setImages([]);
    await onSend(text, imageFiles);
  }, [images, input, onSend]);

  const selectCommand = useCallback((name: string) => {
    setInput(`/${name}`);
    setCommandIdx(-1);
    setCommandSelected(true);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showCommands) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandIdx((prev) => Math.min(prev + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandIdx((prev) => Math.max(prev - 1, -1));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const idx = commandIdx >= 0 ? commandIdx : 0;
        selectCommand(filteredCommands[idx].name);
        return;
      }
    }
    // Prompt history navigation — only when input is empty or already browsing
    const canBrowseHistory = !input || historyIdxRef.current >= 0;

    if (e.key === 'ArrowUp' && promptHistory.length > 0 && canBrowseHistory) {
      e.preventDefault();
      if (historyIdxRef.current === -1) {
        draftRef.current = input;
        historyIdxRef.current = promptHistory.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current--;
      }
      setInput(promptHistory[historyIdxRef.current]);
      return;
    }
    if (e.key === 'ArrowDown' && historyIdxRef.current >= 0) {
      e.preventDefault();
      if (historyIdxRef.current < promptHistory.length - 1) {
        historyIdxRef.current++;
        setInput(promptHistory[historyIdxRef.current]);
      } else {
        historyIdxRef.current = -1;
        setInput(draftRef.current);
      }
      return;
    }

    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend, input, isStreaming, onCancel, showCommands, filteredCommands, commandIdx, selectCommand]);

  return (
    <Paper
      elevation={3}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      sx={{
        p: 2,
        borderTop: '1px solid',
        borderColor: isDragging ? 'primary.main' : 'divider',
        position: 'relative',
        transition: 'border-color 120ms ease',
      }}
    >
      {isDragging && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: (t) => t.palette.mode === 'light'
              ? 'rgba(25, 118, 210, 0.06)'
              : 'rgba(144, 202, 249, 0.08)',
            border: '2px dashed',
            borderColor: 'primary.main',
            borderRadius: 1,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          <Typography variant="body2" color="primary" sx={{ fontWeight: 500 }}>
            Drop images to attach
          </Typography>
        </Box>
      )}
      {images.length > 0 && (
        <Box sx={{ mb: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {images.map((img, index) => (
            <Chip
              key={`${img.name}-${index}`}
              label={img.name}
              onDelete={() => removeImage(index)}
              deleteIcon={<CloseIcon />}
              size="small"
            />
          ))}
        </Box>
      )}

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
        <MicIndicator />

        <TextField
          ref={textFieldRef}
          fullWidth
          multiline
          maxRows={4}
          value={input}
          onChange={(e) => { setInput(e.target.value); setCommandIdx(-1); setCommandSelected(false); }}
          onKeyDown={handleKeyDown}
          placeholder="Type your message..."
        />
        <Popper
          open={showCommands}
          anchorEl={textFieldRef.current}
          placement="top-start"
          sx={{ zIndex: 1300, width: textFieldRef.current?.offsetWidth || 300 }}
        >
          <ClickAwayListener onClickAway={() => setCommandIdx(-1)}>
            <Paper elevation={4} sx={{ py: 0.5, mb: 0.5 }}>
              {filteredCommands.map((cmd, i) => (
                <MenuItem
                  key={cmd.name}
                  selected={i === commandIdx}
                  onClick={() => { selectCommand(cmd.name); }}
                  sx={{ py: 0.5 }}
                >
                  <ListItemText
                    primary={<Typography variant="body2" fontWeight={500}>/{cmd.name}</Typography>}
                    secondary={<Typography variant="caption" color="text.secondary">{cmd.description}</Typography>}
                  />
                </MenuItem>
              ))}
            </Paper>
          </ClickAwayListener>
        </Popper>

        {isStreaming && (
          <IconButton
            color="error"
            onClick={onCancel}
            size="small"
            title="Stop"
          >
            <StopIcon />
          </IconButton>
        )}
        <Button
          variant="contained"
          endIcon={<SendIcon />}
          onClick={() => void handleSend()}
          disabled={!input.trim()}
          sx={{ minWidth: 100 }}
        >
          Send
        </Button>
      </Box>
    </Paper>
  );
});
