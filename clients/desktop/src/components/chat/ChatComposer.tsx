import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Box,
  TextField,
  Button,
  IconButton,
  Paper,
  Chip,
  Tooltip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Popper,
  Typography,
  ClickAwayListener,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import { getCommands } from '../../utils/commands';
import {
  Send as SendIcon,
  AttachFile as AttachFileIcon,
  Close as CloseIcon,
  Stop as StopIcon,
  Mic as MicIcon,
  MicOff as MicOffIcon,
  Videocam as VideocamIcon,
  VideocamOff as VideocamOffIcon,
} from '@mui/icons-material';
import CircularProgress from '@mui/material/CircularProgress';
import type { useMicStore } from '../../store/micStore';

export interface ChatComposerProps {
  scopeKey: string;
  externalDraft: string;
  externalDraftVersion: number;
  isStreaming: boolean;
  asrStatus: ReturnType<typeof useMicStore.getState>['status'];
  asrDevices: ReturnType<typeof useMicStore.getState>['devices'];
  asrDeviceId: ReturnType<typeof useMicStore.getState>['selectedDeviceId'];
  micMenuAnchor: HTMLElement | null;
  cameraActive: boolean;
  cameraWebcams: string[];
  cameraSelectedWebcam: string | null;
  cameraMenuAnchor: HTMLElement | null;
  onSend: (text: string, imageFiles: File[]) => Promise<void>;
  onCancel: () => void;
  onMicToggle: () => void;
  onMicContext: (e: React.MouseEvent<HTMLElement>) => void;
  onCloseMicMenu: () => void;
  onSelectAsrDevice: (deviceId: string) => void;
  onCameraToggle: () => Promise<void>;
  onCameraContext: (e: React.MouseEvent<HTMLElement>) => void;
  onCloseCameraMenu: () => void;
  onSelectCamera: (camera: string) => void;
}

export const ChatComposer: React.FC<ChatComposerProps> = React.memo(({
  scopeKey,
  externalDraft,
  externalDraftVersion,
  isStreaming,
  asrStatus,
  asrDevices,
  asrDeviceId,
  micMenuAnchor,
  cameraActive,
  cameraWebcams,
  cameraSelectedWebcam,
  cameraMenuAnchor,
  onSend,
  onCancel,
  onMicToggle,
  onMicContext,
  onCloseMicMenu,
  onSelectAsrDevice,
  onCameraToggle,
  onCameraContext,
  onCloseCameraMenu,
  onSelectCamera,
}) => {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [commandIdx, setCommandIdx] = useState(-1);
  const [commandSelected, setCommandSelected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textFieldRef = useRef<HTMLDivElement>(null);

  // Prompt history
  const promptHistoryRef = useRef<string[]>([]);
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
  }, [scopeKey]);

  useEffect(() => {
    setInput(externalDraft);
  }, [externalDraft, externalDraftVersion]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    setImages((prev) => [...prev, ...Array.from(e.target.files!)]);
    e.target.value = '';
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    // Save to prompt history
    promptHistoryRef.current.push(text);
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
    // Prompt history navigation (only when command dropdown is not open)
    const history = promptHistoryRef.current;
    if (e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault();
      if (historyIdxRef.current === -1) {
        draftRef.current = input;
        historyIdxRef.current = history.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current--;
      }
      setInput(history[historyIdxRef.current]);
      return;
    }
    if (e.key === 'ArrowDown' && historyIdxRef.current >= 0) {
      e.preventDefault();
      if (historyIdxRef.current < history.length - 1) {
        historyIdxRef.current++;
        setInput(history[historyIdxRef.current]);
      } else {
        historyIdxRef.current = -1;
        setInput(draftRef.current);
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend, input, showCommands, filteredCommands, commandIdx, selectCommand]);

  return (
    <Paper
      elevation={3}
      sx={{
        p: 2,
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <IconButton
          onClick={() => fileInputRef.current?.click()}
        >
          <AttachFileIcon />
        </IconButton>

        <Tooltip title={asrStatus === 'idle' ? 'Start dictation (right-click: select mic)' : 'Stop dictation'}>
          <IconButton
            onClick={onMicToggle}
            onContextMenu={onMicContext}
            sx={{
              color: asrStatus === 'listening' ? 'error.main' : 'inherit',
            }}
          >
            {asrStatus === 'processing' ? (
              <CircularProgress size={24} />
            ) : asrStatus === 'listening' ? (
              <MicIcon />
            ) : (
              <MicOffIcon />
            )}
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={micMenuAnchor}
          open={Boolean(micMenuAnchor)}
          onClose={onCloseMicMenu}
        >
          {asrDevices.map((device) => (
            <MenuItem
              key={device.deviceId}
              onClick={() => onSelectAsrDevice(device.deviceId)}
              selected={device.deviceId === asrDeviceId}
            >
              {device.deviceId === asrDeviceId && (
                <ListItemIcon><CheckIcon fontSize="small" /></ListItemIcon>
              )}
              <ListItemText inset={device.deviceId !== asrDeviceId}>
                {device.label}
              </ListItemText>
            </MenuItem>
          ))}
          {asrDevices.length === 0 && (
            <MenuItem disabled>No microphones found</MenuItem>
          )}
        </Menu>

        <Tooltip title={cameraActive ? 'Stop camera (right-click: select webcam)' : 'Start camera (right-click: select webcam)'}>
          <IconButton
            onClick={() => void onCameraToggle()}
            onContextMenu={onCameraContext}
            sx={{
              color: cameraActive ? 'success.main' : 'inherit',
              animation: cameraActive ? 'pulse 1.5s infinite' : 'none',
              '@keyframes pulse': {
                '0%': { opacity: 1 },
                '50%': { opacity: 0.5 },
                '100%': { opacity: 1 },
              },
            }}
          >
            {cameraActive ? <VideocamIcon /> : <VideocamOffIcon />}
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={cameraMenuAnchor}
          open={Boolean(cameraMenuAnchor)}
          onClose={onCloseCameraMenu}
        >
          {cameraWebcams.map((cam) => (
            <MenuItem
              key={cam}
              onClick={() => onSelectCamera(cam)}
              selected={cam === cameraSelectedWebcam}
            >
              {cam === cameraSelectedWebcam && (
                <ListItemIcon><CheckIcon fontSize="small" /></ListItemIcon>
              )}
              <ListItemText inset={cam !== cameraSelectedWebcam}>
                {cam}
              </ListItemText>
            </MenuItem>
          ))}
          {cameraWebcams.length === 0 && (
            <MenuItem disabled>No webcams found</MenuItem>
          )}
        </Menu>

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
