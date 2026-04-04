import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box,
  Typography,
  Snackbar,
  Alert,
  ToggleButtonGroup,
  ToggleButton,
  Collapse,
  Paper,
  IconButton,
  TextField,
  InputAdornment,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import { AnimatePresence } from 'framer-motion';
import { useConversationStore } from '../../store/conversationStore';
import { useAuthStore } from '../../store/authStore';

import { useTTS } from '../../hooks/useTTS';
import { useVisionStore } from '../../store/visionStore';
import { useCharacterPanel } from '../../hooks/useCharacterPanel';
import { useInteractiveASR } from '../../hooks/useInteractiveASR';
import { useMicStore } from '../../store/micStore';
import { storage } from '../../utils/storage';
import { useAgentStore } from '../../store/agentStore';
import { useStreamingChat } from '../../hooks/useStreamingChat';
import { InteractiveCallBar } from '../InteractiveCallBar';
import { MessageBubble } from './MessageBubble';
import { FrameSeparator } from '../FrameSeparator';
import { SelectionChips } from './SelectionChips';
import { ChatComposer } from './ChatComposer';
import { ToolApprovalBar, ApprovalRequest } from './ToolApprovalBar';

interface ChatWidgetProps {
  characterWindowOpen?: boolean;
  agentId?: number | null;
}

export const ChatWidget: React.FC<ChatWidgetProps> = ({ characterWindowOpen = false, agentId: agentIdProp = null }) => {
  const storeAgentId = useAgentStore((s) => s.selectedAgentId);
  const agentId = agentIdProp ?? storeAgentId;
  const {
    messages,
    frames,
    currentConversation,
    hasMoreMessages,
    isLoadingMessages,
    loadMoreMessages,
    loadConversation,
    setCurrentConversationId,
  } = useConversationStore();
  const { compactedUpToId, compactedContext } = useConversationStore();
  const contextSize = useAuthStore((s) => s.user?.context_size) || 8192;

  // Display mode: "all" shows full history, "context" shows only LLM context window
  const [displayMode, setDisplayMode] = useState<'all' | 'context'>('all');
  const [contextBannerExpanded, setContextBannerExpanded] = useState(false);

  // Message search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    const indices: number[] = [];
    messages.forEach((m, i) => {
      if (m.content?.toLowerCase().includes(q)) indices.push(i);
    });
    return indices;
  }, [messages, searchQuery]);

  // Ctrl+F to open search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen]);

  // Scroll to current match
  useEffect(() => {
    if (searchMatches.length > 0) {
      const msgIdx = searchMatches[searchMatchIdx];
      const el = document.querySelector(`[data-msg-index="${msgIdx}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [searchMatchIdx, searchMatches]);

  // Character panel hook
  const {
    amplitudeRef,
    setActiveAgentId,
    pushAgentCharacterConfig,
    onAmplitudeUpdate,
    onTTSPlaybackStart,
  } = useCharacterPanel({
    characterWindowOpen,
    messages,
    currentConversationId: currentConversation?.id || null,
  });

  // TTS (with amplitude callback for character lip sync)
  const { speak, stop: stopTTS, isPlaying: isTTSPlaying, queueText, clearQueue, isQueueActive } = useTTS(onAmplitudeUpdate, onTTSPlaybackStart);
  const setActiveAgentForTTS = useCallback((agentIdVal: number | null) => {
    setActiveAgentId(agentIdVal);
  }, [setActiveAgentId]);
  const ttsRef = useRef({ speak, stopTTS, isTTSPlaying, setActiveAgentForTTS });
  ttsRef.current = { speak, stopTTS, isTTSPlaying, setActiveAgentForTTS };

  // Streaming chat hook
  const streaming = useStreamingChat({
    agentId,
    currentConversation,
    messages,
    hasMoreMessages,
    isLoadingMessages,
    loadMoreMessages,
    loadConversation,
    setCurrentConversationId,
    queueText,
    clearQueue,
    amplitudeRef,
    pushAgentCharacterConfig,
  });

  // Reset display mode on conversation change
  useEffect(() => {
    setDisplayMode('all');
    setContextBannerExpanded(false);
  }, [currentConversation?.id]);

  // Scroll to bottom when switching display mode (after render settles)
  useEffect(() => {
    requestAnimationFrame(() => {
      streaming.messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, [displayMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear active speaker when TTS queue finishes playing
  useEffect(() => {
    if (!isQueueActive && !streaming.isStreaming) {
      setActiveAgentId(null);
      amplitudeRef.current = { amplitude: 0, isPlaying: false, isThinking: false };
    }
  }, [isQueueActive, streaming.isStreaming, setActiveAgentId, amplitudeRef]);

  // Interactive ASR hook
  const asr = useInteractiveASR({
    agentId,
    currentConversationId: streaming.activeConversationId,
    isStreaming: streaming.isStreaming,
    isQueueActive,
    handleSendText: streaming.handleSendText,
    pushExternalDraft: streaming.pushExternalDraft,
    stopTTSPlayback: () => { stopTTS(); clearQueue(); },
  });

  // Always-listen: auto-start mic on mount + send PTT keycode to main process
  useEffect(() => {
    useMicStore.getState().initAlwaysListen();
    const electron = (window as any).electron;
    const keycode = storage.getPTTKeycode();
    if (keycode !== null) electron?.ptt?.setKeycode(keycode);
  }, []);

  // Push-to-talk: Ctrl+Space or headset MediaPlayPause
  useEffect(() => {
    const { activatePTT, deactivatePTT } = useMicStore.getState();

    // Ctrl+Space: hold-to-talk
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        activatePTT();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        deactivatePTT();
      }
    };


    // Headset button via Electron global shortcut (double-press MediaPlayPause)
    // Uses activateInteraction (not PTT) so the 30s idle timer applies
    const electron = (window as any).electron;
    let cleanupPTT: (() => void) | undefined;
    if (electron?.ptt?.onToggle) {
      cleanupPTT = electron.ptt.onToggle(() => {
        const mic = useMicStore.getState();
        if (mic.interactionActive) {
          mic.deactivateInteraction();
        } else {
          mic.activateInteraction();
        }
      });
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      cleanupPTT?.();
    };
  }, []);

  // Vision (camera toggle)
  const {
    isActive: cameraActive,
    webcams: cameraWebcams,
    selectedWebcam: cameraSelectedWebcam,
    loadWebcams: loadCameraWebcams,
    startVision,
    stopVision,
    setSelectedWebcam: setCameraSelectedWebcam,
  } = useVisionStore();
  const [cameraMenuAnchor, setCameraMenuAnchor] = useState<HTMLElement | null>(null);

  const handleCameraToggle = useCallback(async () => {
    if (cameraActive) {
      stopVision();
    } else {
      if (cameraWebcams.length === 0) await loadCameraWebcams();
      startVision();
    }
  }, [cameraActive, cameraWebcams.length, loadCameraWebcams, startVision, stopVision]);

  const handleCameraContext = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const anchor = e.currentTarget;
    loadCameraWebcams().then(() => {
      setCameraMenuAnchor(anchor);
    });
  }, [loadCameraWebcams]);

  // Host tool approval (IPC from Electron main process)
  const [hostApproval, setHostApproval] = useState<{ approvalId: string; request: ApprovalRequest } | null>(null);

  useEffect(() => {
    const cleanup = window.electron?.hostTools?.onApprovalRequest?.((data) => {
      setHostApproval({
        approvalId: data.approvalId,
        request: {
          toolName: data.ruleKey,
          description: `An agent wants to use ${data.ruleKey}`,
          detail: data.detail,
          options: data.options.map((label) => ({
            label,
            value: label.toLowerCase().replace(/\s+/g, '_'),
            color: (label === 'Deny' ? 'error' : label === 'Accept' ? 'success' : 'default') as any,
          })),
        },
      });
    });
    return cleanup;
  }, []);

  const handleHostApprovalRespond = useCallback((value: string) => {
    if (!hostApproval) return;
    window.electron?.hostTools?.sendApprovalResponse(hostApproval.approvalId, value);
    setHostApproval(null);
  }, [hostApproval]);

  // Filter messages based on display mode
  const displayedMessages = useMemo(() => {
    if (displayMode === 'context') {
      return messages.filter(m => (m.id ?? Infinity) > compactedUpToId);
    }
    return messages;
  }, [messages, displayMode, compactedUpToId]);

  // Token count: frontend estimate from persisted messages + live streaming content
  const tokenCount = useMemo(() => {
    const contextMsgs = messages.filter(m => (m.id ?? Infinity) > compactedUpToId);
    const wc = (t: string | undefined) => t ? t.split(/\s+/).length : 0;
    const msgWords = contextMsgs.reduce((n, m) => n + wc(m.content) + wc(m.thinking), 0);
    const streamWords = wc(streaming.streamingContent) + wc(streaming.streamingThinking);
    const contextWords = wc(compactedContext);
    return Math.round((msgWords + streamWords + contextWords) * 1.3);
  }, [messages, compactedUpToId, compactedContext, streaming.streamingContent, streaming.streamingThinking]);

  // Message rendering
  const messageElements = useMemo(() => {
    const combined = [...displayedMessages, ...streaming.streamingMessages];
    const displayedCount = displayedMessages.length;
    const activeStreamingMsg = streaming.isStreaming && streaming.streamingMessages.length > 0
      ? streaming.streamingMessages[streaming.streamingMessages.length - 1]
      : null;
    const elements: React.ReactNode[] = [];
    let lastFrameId: number | undefined;

    combined.forEach((message, index) => {
      const currentFrameId = message.frame_id;
      if (currentFrameId && currentFrameId !== lastFrameId && lastFrameId !== undefined) {
        const frameInfo = frames[currentFrameId];
        if (frameInfo) {
          elements.push(
            <FrameSeparator key={`frame-sep-${currentFrameId}`} frame={frameInfo} />
          );
        }
      }
      lastFrameId = currentFrameId;

      const isActiveStreaming = message === activeStreamingMsg;
      const isCompacted = message.id != null && message.id <= compactedUpToId;
      const prevMessage = index > 0 ? combined[index - 1] : null;
      const consecutive = prevMessage != null && prevMessage.role === message.role;
      // Stable key: DB messages use their ID, streaming messages use their position in streamingMessages
      const key = message.id ? `msg-${message.id}` : `stream-${index - displayedCount}`;
      const isSearchMatch = searchQuery && searchMatches.includes(index);
      elements.push(
        <Box
          key={`wrap-${key}`}
          data-msg-index={index}
        >
        <MessageBubble
          key={key}
          message={message}
          index={index}
          consecutive={consecutive}
          isLast={index === combined.length - 1}
          isStreaming={isActiveStreaming}
          streamingThinking={isActiveStreaming ? streaming.streamingThinking : ''}
          streamingContent={isActiveStreaming ? streaming.streamingContent : ''}
          displayedThinking={isActiveStreaming ? streaming.streamingThinking : ''}
          displayedContent={isActiveStreaming ? streaming.streamingContent : ''}
          justFinishedStreaming={index === combined.length - 1 && streaming.justFinishedStreaming}
          expandedThinking={streaming.expandedThinking}
          onToggleThinking={streaming.toggleThinking}
          onResend={isCompacted ? undefined : streaming.handleResend}
          onDelete={streaming.handleDelete}
          searchHighlight={isSearchMatch ? searchQuery : undefined}
          ttsRef={ttsRef}
        />
        </Box>
      );
    });

    return elements;
  }, [
    displayedMessages,
    streaming.streamingMessages,
    streaming.isStreaming,
    frames,
    streaming.streamingThinking,
    streaming.streamingContent,
    streaming.justFinishedStreaming,
    streaming.expandedThinking,
    streaming.toggleThinking,
    streaming.handleResend,
    streaming.handleDelete,
    compactedUpToId,
    searchQuery,
    searchMatches,
    searchMatchIdx,
  ]);

  const messagesPane = useMemo(() => (
    <Box
      ref={streaming.messagesContainerRef}
      sx={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        p: 3,
        bgcolor: 'background.default',
        minWidth: 0,
      }}
    >
      {isLoadingMessages && displayMode === 'all' && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Loading earlier messages...
          </Typography>
        </Box>
      )}

      {displayMode === 'context' && compactedContext && (
        <Paper variant="outlined" sx={{ mx: 1, mb: 2, p: 1.5, bgcolor: 'action.hover', borderStyle: 'dashed' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Context Summary
            </Typography>
            <IconButton size="small" onClick={() => setContextBannerExpanded(v => !v)}>
              {contextBannerExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </IconButton>
          </Box>
          <Collapse in={contextBannerExpanded}>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
              {compactedContext}
            </Typography>
          </Collapse>
          {!contextBannerExpanded && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {compactedContext.slice(0, 150)}{compactedContext.length > 150 ? '...' : ''}
            </Typography>
          )}
        </Paper>
      )}

      <AnimatePresence>
        {messageElements}
      </AnimatePresence>
      {/* Queued messages rendered outside main memo to avoid disrupting streaming */}
      {streaming.queuedMessages.map((msg, i) => (
        <Box key={`queued-${i}`} sx={{ mb: 0.5, display: 'flex', justifyContent: 'flex-end', opacity: 0.5 }}>
          <Box sx={{ maxWidth: '80%' }}>
            <Paper elevation={0} sx={{ p: 2, backgroundColor: 'action.hover', border: '1px dashed', borderColor: 'divider' }}>
              <Typography variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>Queued</Typography>
              <Typography variant="body2">{msg.content}</Typography>
            </Paper>
          </Box>
        </Box>
      ))}
      <div ref={streaming.messagesEndRef} />
    </Box>
  ), [isLoadingMessages, messageElements, displayMode, compactedContext, contextBannerExpanded, streaming.queuedMessages]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%' }}>

      {/* Display mode toggle + token usage */}
      {currentConversation && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 0.5 }}>
          <ToggleButtonGroup
            value={displayMode}
            exclusive
            onChange={(_, v) => v && setDisplayMode(v)}
            size="small"
            sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: '0.7rem', textTransform: 'none' } }}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="context">Context</ToggleButton>
          </ToggleButtonGroup>
          <Typography
            variant="caption"
            sx={{
              color: tokenCount > contextSize * 0.9 ? 'error.main'
                : tokenCount > contextSize * 0.8 ? 'warning.main'
                : 'text.secondary',
              fontWeight: tokenCount > contextSize * 0.8 ? 600 : 400,
            }}
          >
            {tokenCount.toLocaleString()} / {contextSize.toLocaleString()} tokens
          </Typography>
        </Box>
      )}

      {/* Search bar */}
      {searchOpen && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 2, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
          <TextField
            inputRef={searchInputRef}
            size="small"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchMatchIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (searchMatches.length > 0) {
                  setSearchMatchIdx(prev => (prev + (e.shiftKey ? -1 : 1) + searchMatches.length) % searchMatches.length);
                }
              }
              if (e.key === 'Escape') {
                setSearchOpen(false);
                setSearchQuery('');
              }
            }}
            sx={{ flex: 1, '& .MuiInputBase-root': { height: 32, fontSize: '0.85rem' } }}
            InputProps={{
              startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} /></InputAdornment>,
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40, textAlign: 'center' }}>
            {searchMatches.length > 0 ? `${searchMatchIdx + 1}/${searchMatches.length}` : '0/0'}
          </Typography>
          <IconButton size="small" onClick={() => setSearchMatchIdx(prev => (prev - 1 + searchMatches.length) % searchMatches.length)} disabled={searchMatches.length === 0}>
            <KeyboardArrowUpIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" onClick={() => setSearchMatchIdx(prev => (prev + 1) % searchMatches.length)} disabled={searchMatches.length === 0}>
            <KeyboardArrowDownIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" onClick={() => { setSearchOpen(false); setSearchQuery(''); }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      )}

      {messagesPane}

      {/* Selection context chips — above input */}
      <SelectionChips />

      {/* Bottom area: approval bar, interactive call bar, or typing input */}
      {(streaming.pendingApproval || hostApproval) ? (
        <ToolApprovalBar
          request={hostApproval ? hostApproval.request : {
            toolName: streaming.pendingApproval!.tool_name,
            description: streaming.pendingApproval!.description,
            detail: Object.entries(streaming.pendingApproval!.tool_args)
              .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join('\n'),
            riskLevel: streaming.pendingApproval!.risk_level,
            agentName: streaming.pendingApproval!.name || undefined,
            options: [
              { label: 'Accept', value: 'approve', color: 'success' },
              { label: 'Deny', value: 'deny', color: 'error' },
            ],
          }}
          onRespond={hostApproval
            ? handleHostApprovalRespond
            : (value) => streaming.respondToApproval(value === 'approve')
          }
        />
      ) : asr.interactionActive ? (
        <InteractiveCallBar
          asrStatus={asr.asrStatus}
          interactionActive={asr.interactionActive}
          lastTranscript={asr.lastTranscript}
          isStreaming={streaming.isStreaming}
          isTTSPlaying={isQueueActive}
          onHangUp={() => useMicStore.getState().deactivateInteraction()}
        />
      ) : (
        <ChatComposer
          scopeKey={`${agentId ?? 'group'}:${streaming.activeConversationId ?? 'new'}`}
          externalDraft={streaming.externalDraft}
          externalDraftVersion={streaming.externalDraftVersion}
          isStreaming={streaming.isStreaming}
          cameraActive={cameraActive}
          cameraWebcams={cameraWebcams}
          cameraSelectedWebcam={cameraSelectedWebcam}
          cameraMenuAnchor={cameraMenuAnchor}
          onSend={streaming.handleSend}
          onCancel={streaming.handleCancel}
          onCameraToggle={handleCameraToggle}
          onCameraContext={handleCameraContext}
          onCloseCameraMenu={() => setCameraMenuAnchor(null)}
          onSelectCamera={(camera) => {
            setCameraSelectedWebcam(camera);
            setCameraMenuAnchor(null);
          }}
        />
      )}
      <Snackbar
        open={!!streaming.errorToast}
        autoHideDuration={6000}
        onClose={() => streaming.setErrorToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert onClose={() => streaming.setErrorToast(null)} severity="error" variant="filled" sx={{ width: '100%' }}>
          {streaming.errorToast}
        </Alert>
      </Snackbar>
      <Snackbar
        open={!!streaming.infoToast}
        autoHideDuration={3000}
        onClose={() => streaming.setInfoToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert onClose={() => streaming.setInfoToast(null)} severity="info" variant="filled" sx={{ width: '100%' }}>
          {streaming.infoToast}
        </Alert>
      </Snackbar>
    </Box>
  );
};
