import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box,
  Typography,
  Snackbar,
  Alert,
  Paper,
  IconButton,
  TextField,
  InputAdornment,
  Dialog,
  DialogTitle,
  DialogContent,
  Table,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Tooltip,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  Avatar,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import { AnimatePresence } from 'framer-motion';
import { useConversationStore } from '../../store/conversationStore';
import { useAuthStore } from '../../store/authStore';
import { apiClient } from '../../api/client';
import type { Conversation } from '../../api/types';
import { storage } from '../../utils/storage';

import { useTTS } from '../../hooks/useTTS';
import { useVisionStore } from '../../store/visionStore';
import { useCharacterPanel } from '../../hooks/useCharacterPanel';
import { useInteractiveASR } from '../../hooks/useInteractiveASR';
import { useMicStore } from '../../store/micStore';
import { usePersonaStore } from '../../store/personaStore';
import { useStreamingChat } from '../../hooks/useStreamingChat';
import { useContextBreakdown } from '../../hooks/useContextBreakdown';
import { InteractiveCallBar } from '../InteractiveCallBar';
import { MessageBubble } from './MessageBubble';
import { SelectionChips } from './SelectionChips';
import { ChatComposer } from './ChatComposer';
import { ToolApprovalBar, ApprovalRequest } from './ToolApprovalBar';

interface ChatWidgetProps {
  characterWindowOpen?: boolean;
  personaId?: number | null;
}

export const ChatWidget: React.FC<ChatWidgetProps> = ({ characterWindowOpen = false, personaId: personaIdProp = null }) => {
  const storePersonaId = usePersonaStore((s) => s.selectedPersonaId);
  const personaId = personaIdProp ?? storePersonaId;
  const {
    messages,
    currentConversation,
    hasMoreMessages,
    isLoadingMessages,
    loadMoreMessages,
    loadConversation,
    setCurrentConversationId,
  } = useConversationStore();
  const { compactedUpToId, compactedContext } = useConversationStore();
  const contextSize = useAuthStore((s) => s.user?.context_size) || 8192;

  const [breakdownDialogOpen, setBreakdownDialogOpen] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeConversations, setResumeConversations] = useState<Conversation[]>([]);
  const [resumeActiveIdx, setResumeActiveIdx] = useState(0);
  const [personaSheetOpen, setPersonaSheetOpen] = useState(false);
  const [personaActiveIdx, setPersonaActiveIdx] = useState(0);
  const [personaSheetError, setPersonaSheetError] = useState('');

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
    setActivePersonaId,
    pushPersonaCharacterConfig,
    onAmplitudeUpdate,
    onTTSPlaybackStart,
  } = useCharacterPanel({
    characterWindowOpen,
    messages,
    currentConversationId: currentConversation?.id || null,
  });

  // TTS (with amplitude callback for character lip sync)
  const { speak, stop: stopTTS, isPlaying: isTTSPlaying, queueText, clearQueue, isQueueActive } = useTTS(onAmplitudeUpdate, onTTSPlaybackStart);
  const setActivePersonaForTTS = useCallback((id: number | null) => {
    setActivePersonaId(id);
  }, [setActivePersonaId]);
  const ttsRef = useRef({ speak, stopTTS, clearQueue, isTTSPlaying, setActivePersonaForTTS });
  ttsRef.current = { speak, stopTTS, clearQueue, isTTSPlaying, setActivePersonaForTTS };

  // Streaming chat hook
  const streaming = useStreamingChat({
    personaId,
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
    pushPersonaCharacterConfig,
  });

  // Who is answering here. The server binding on the loaded conversation wins
  // over the client-side selection: the conversation is bound backend-side and
  // that binding is what the next turn will actually use.
  const personas = usePersonaStore((s) => s.personas);
  const activePersonaId = currentConversation?.persona_id ?? personaId;
  const activePersona = useMemo(
    () => personas.find((p) => p.id === activePersonaId) || null,
    [personas, activePersonaId],
  );
  const breakdownData = useContextBreakdown({
    personaId: activePersonaId,
    enabled: breakdownDialogOpen,
  });

  // Clear active speaker when TTS queue finishes playing
  useEffect(() => {
    if (!isQueueActive && !streaming.isStreaming) {
      setActivePersonaId(null);
      amplitudeRef.current = { amplitude: 0, isPlaying: false, isThinking: false };
    }
  }, [isQueueActive, streaming.isStreaming, setActivePersonaId, amplitudeRef]);

  // /context slash command opens the breakdown dialog
  useEffect(() => {
    const handler = () => setBreakdownDialogOpen(true);
    window.addEventListener('kurisu:open-context-breakdown', handler);
    return () => window.removeEventListener('kurisu:open-context-breakdown', handler);
  }, []);

  // /resume slash command opens the conversation picker
  useEffect(() => {
    const handler = () => setResumeDialogOpen(true);
    window.addEventListener('kurisu:open-resume-picker', handler);
    return () => window.removeEventListener('kurisu:open-resume-picker', handler);
  }, []);

  // Fetch conversations when the resume dialog opens
  useEffect(() => {
    if (!resumeDialogOpen) return;
    setResumeLoading(true);
    apiClient.getConversations(personaId ?? undefined)
      .then((convs) => setResumeConversations(convs))
      .catch((err) => {
        console.error('Failed to load conversations:', err);
        setResumeConversations([]);
      })
      .finally(() => setResumeLoading(false));
  }, [resumeDialogOpen, personaId]);

  const handleResumeSelect = useCallback(async (conv: Conversation) => {
    setResumeDialogOpen(false);
    if (conv.id === currentConversation?.id) return;
    await loadConversation(conv.id);
    storage.setPersonaConversationId(conv.persona_id ?? personaId ?? 'unbound', conv.id);
  }, [personaId, currentConversation?.id, loadConversation]);

  // Reset highlight when the resume picker opens
  useEffect(() => {
    if (resumeDialogOpen) setResumeActiveIdx(0);
  }, [resumeDialogOpen]);

  // Keyboard navigation for the resume picker
  useEffect(() => {
    if (!resumeDialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setResumeDialogOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setResumeActiveIdx((i) => Math.min(i + 1, Math.max(0, resumeConversations.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setResumeActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const conv = resumeConversations[resumeActiveIdx];
        if (conv) handleResumeSelect(conv);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [resumeDialogOpen, resumeConversations, resumeActiveIdx, handleResumeSelect]);

  // /persona slash command opens the persona sheet
  useEffect(() => {
    const handler = () => setPersonaSheetOpen(true);
    window.addEventListener('kurisu:open-persona-picker', handler);
    return () => window.removeEventListener('kurisu:open-persona-picker', handler);
  }, []);

  const selectPersona = usePersonaStore((s) => s.selectPersona);

  // Picking a persona is a per-conversation override, not a global mode switch:
  // PATCH /conversations/{id} rebinds the open conversation so the next turn —
  // and any other client — sees the same answerer. With no conversation open yet
  // there is nothing to patch; the selection alone decides who the conversation
  // about to be created binds to.
  const handlePersonaPick = useCallback(async (id: number) => {
    setPersonaSheetError('');
    const convId = currentConversation?.id;
    if (convId && id !== currentConversation?.persona_id) {
      try {
        await apiClient.patchConversation(convId, { persona_id: id });
        storage.setPersonaConversationId(id, convId);
        await loadConversation(convId);
      } catch (err: any) {
        setPersonaSheetError(err?.response?.data?.detail || err?.message || 'Failed to switch persona');
        return;
      }
    }
    if (id !== storePersonaId) {
      selectPersona(id);
    }
    setPersonaSheetOpen(false);
  }, [currentConversation?.id, currentConversation?.persona_id, loadConversation, selectPersona, storePersonaId]);

  // A disabled persona cannot answer, so it is not offered.
  const selectablePersonas = useMemo(
    () => personas.filter((p) => p.enabled),
    [personas],
  );

  // Reset highlight when the sheet opens — start on whoever is answering.
  useEffect(() => {
    if (!personaSheetOpen) return;
    setPersonaSheetError('');
    const idx = selectablePersonas.findIndex((p) => p.id === activePersonaId);
    setPersonaActiveIdx(idx >= 0 ? idx : 0);
  }, [personaSheetOpen, selectablePersonas, activePersonaId]);

  // Keyboard navigation for the persona sheet
  useEffect(() => {
    if (!personaSheetOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPersonaSheetOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPersonaActiveIdx((i) => Math.min(i + 1, Math.max(0, selectablePersonas.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPersonaActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const persona = selectablePersonas[personaActiveIdx];
        if (persona) void handlePersonaPick(persona.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [personaSheetOpen, selectablePersonas, personaActiveIdx, handlePersonaPick]);

  // Interactive ASR hook
  const asr = useInteractiveASR({
    personaId,
    currentConversationId: streaming.activeConversationId,
    isStreaming: streaming.isStreaming,
    isQueueActive,
    handleSendText: streaming.handleSendText,
    pushExternalDraft: streaming.pushExternalDraft,
    stopTTSPlayback: () => { stopTTS(); clearQueue(); },
  });

  // Always-listen: auto-start mic on mount
  useEffect(() => {
    useMicStore.getState().initAlwaysListen();
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

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Vision (camera toggle) — driven only by the /vision slash command
  const {
    isActive: cameraActive,
    webcams: cameraWebcams,
    loadWebcams: loadCameraWebcams,
    startVision,
    stopVision,
  } = useVisionStore();

  const handleCameraToggle = useCallback(async () => {
    if (cameraActive) {
      stopVision();
    } else {
      if (cameraWebcams.length === 0) await loadCameraWebcams();
      startVision();
    }
  }, [cameraActive, cameraWebcams.length, loadCameraWebcams, startVision, stopVision]);

  useEffect(() => {
    const handler = () => { void handleCameraToggle(); };
    window.addEventListener('kurisu:toggle-vision', handler);
    return () => window.removeEventListener('kurisu:toggle-vision', handler);
  }, [handleCameraToggle]);

  // Host tool approval (IPC from Electron main process)
  const [hostApproval, setHostApproval] = useState<{ approvalId: string; request: ApprovalRequest } | null>(null);

  useEffect(() => {
    const cleanup = window.electron?.hostTools?.onApprovalRequest?.((data) => {
      setHostApproval({
        approvalId: data.approvalId,
        request: {
          toolName: data.ruleKey,
          description: `The assistant wants to use ${data.ruleKey}`,
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
    // Dedupe by _clientKey across the combined array. handleDone moves
    // streaming bubbles into `messages` and then clears `streamingMessages`,
    // but those two updates can land in different React renders on slow CI
    // (Zustand's useSyncExternalStore notification doesn't reliably batch
    // with adjacent setState calls). Without dedupe, the brief overlap
    // renders the same bubble twice and trips strict-mode locator
    // assertions.
    const seen = new Set<string>();
    const combined = [...messages, ...streaming.streamingMessages].filter((m) => {
      if (!m._clientKey) return true;
      if (seen.has(m._clientKey)) return false;
      seen.add(m._clientKey);
      return true;
    });
    const displayedCount = messages.length;
    const activeStreamingMsg = streaming.isStreaming && streaming.streamingMessages.length > 0
      ? streaming.streamingMessages[streaming.streamingMessages.length - 1]
      : null;
    const elements: React.ReactNode[] = [];

    combined.forEach((message, index) => {
      const isActiveStreaming = message === activeStreamingMsg;
      const prevMessage = index > 0 ? combined[index - 1] : null;
      const consecutive = prevMessage != null && prevMessage.role === message.role;
      // Stable key: prefer the per-message _clientKey (assigned to streaming
      // messages), then DB id (older persisted messages), then a positional
      // fallback. Without _clientKey persistence the bubble would remount and
      // replay its entry animation on every state churn.
      const key = message._clientKey || (message.id ? `msg-${message.id}` : `stream-${index - displayedCount}`);
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
          searchHighlight={isSearchMatch ? searchQuery : undefined}
          ttsRef={ttsRef}
          isQueueActive={isQueueActive}
        />
        </Box>
      );
    });

    return elements;
  }, [
    messages,
    streaming.streamingMessages,
    streaming.isStreaming,
    streaming.streamingThinking,
    streaming.streamingContent,
    streaming.justFinishedStreaming,
    streaming.expandedThinking,
    streaming.toggleThinking,
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
      {isLoadingMessages && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Loading earlier messages...
          </Typography>
        </Box>
      )}

      {/* Banner only on conversations created by compaction (seeded summary, no messages
          rolled in). Old in-place compactions have compactedUpToId > 0. */}
      {compactedContext && compactedUpToId === 0 && (
        <Paper
          variant="outlined"
          sx={{
            mb: 2,
            p: 2,
            borderStyle: 'dashed',
            bgcolor: 'action.hover',
          }}
        >
          <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ display: 'block', mb: 0.5 }}>
            Compacted Conversation
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
            {compactedContext}
          </Typography>
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
  ), [isLoadingMessages, messageElements, streaming.queuedMessages, compactedContext]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>

      {/* Header: who is answering (click to override for this conversation) + token usage */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 2, py: 0.5 }}>
        <Tooltip title={currentConversation ? 'Change who answers in this conversation' : 'Choose who answers'}>
          <ListItemButton
            onClick={() => setPersonaSheetOpen(true)}
            sx={{ flex: '0 1 auto', minWidth: 0, gap: 1, px: 1, py: 0.25, borderRadius: 1 }}
          >
            <Avatar
              src={activePersona?.avatar_uuid ? apiClient.getImageUrl(activePersona.avatar_uuid) : undefined}
              sx={{
                width: 22,
                height: 22,
                bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'),
                flexShrink: 0,
              }}
            >
              {!activePersona?.avatar_uuid && (
                <SmartToyIcon sx={{ fontSize: 13, color: 'text.secondary' }} />
              )}
            </Avatar>
            <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 0 }} noWrap>
              {activePersona?.name || 'Default persona'}
            </Typography>
          </ListItemButton>
        </Tooltip>
        {currentConversation && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
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
            {currentConversation && (
              <Tooltip title="View context breakdown">
                <IconButton
                  size="small"
                  onClick={() => setBreakdownDialogOpen(true)}
                  sx={{ p: 0.25 }}
                >
                  <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        )}
      </Box>

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
            executionLocation: streaming.pendingApproval!.execution_location,
            requesterName: streaming.pendingApproval!.name || undefined,
          }}
          onRespond={hostApproval
            ? handleHostApprovalRespond
            : (value) => streaming.respondToApproval(value)
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
          scopeKey={`${personaId ?? 'unbound'}:${streaming.activeConversationId ?? 'new'}`}
          externalDraft={streaming.externalDraft}
          externalDraftVersion={streaming.externalDraftVersion}
          isStreaming={streaming.isStreaming}
          onSend={streaming.handleSend}
          onCancel={streaming.handleCancel}
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

      {/* Context Breakdown Dialog */}
      <Dialog
        open={breakdownDialogOpen}
        onClose={() => setBreakdownDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Context Breakdown {activePersona ? `- ${activePersona.name}` : ''}
          <IconButton size="small" onClick={() => setBreakdownDialogOpen(false)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {breakdownData ? (
            <Box>
              {/* Progress bar */}
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                  <Typography variant="body2">
                    {breakdownData.total_tokens.toLocaleString()} / {breakdownData.context_limit.toLocaleString()} tokens
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {Math.round((breakdownData.total_tokens / breakdownData.context_limit) * 100)}%
                  </Typography>
                </Box>
                <Box sx={{ position: 'relative' }}>
                  <LinearProgress
                    variant="determinate"
                    value={Math.min(100, (breakdownData.total_tokens / breakdownData.context_limit) * 100)}
                    sx={{
                      height: 8,
                      borderRadius: 1,
                      backgroundColor: 'action.hover',
                      '& .MuiLinearProgress-bar': {
                        backgroundColor: breakdownData.total_tokens > breakdownData.context_limit * 0.9
                          ? 'error.main'
                          : breakdownData.total_tokens > breakdownData.context_limit * 0.8
                          ? 'warning.main'
                          : 'primary.main',
                      },
                    }}
                  />
                  <Tooltip title="Auto-compact triggers at 90% of the context window">
                    <Box
                      sx={{
                        position: 'absolute',
                        top: -2,
                        bottom: -2,
                        left: '90%',
                        width: '2px',
                        bgcolor: 'warning.main',
                        cursor: 'help',
                      }}
                    />
                  </Tooltip>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    Auto-compact at {Math.round(breakdownData.context_limit * 0.9).toLocaleString()} (90%)
                  </Typography>
                </Box>
              </Box>

              {/* Token breakdown table */}
              <Typography variant="subtitle2" gutterBottom>Token Usage by Component</Typography>
              <Table size="small" sx={{ mb: 2 }}>
                <TableBody>
                  <TableRow>
                    <TableCell>System Prompt</TableCell>
                    <TableCell align="right">{breakdownData.system_prompt_tokens.toLocaleString()}</TableCell>
                  </TableRow>
                  {breakdownData.memory_tokens > 0 && (
                    <TableRow>
                      <TableCell>Assistant Memory</TableCell>
                      <TableCell align="right">{breakdownData.memory_tokens.toLocaleString()}</TableCell>
                    </TableRow>
                  )}
                  {breakdownData.compacted_context_tokens > 0 && (
                    <TableRow>
                      <TableCell>Compacted Context</TableCell>
                      <TableCell align="right">{breakdownData.compacted_context_tokens.toLocaleString()}</TableCell>
                    </TableRow>
                  )}
                  {breakdownData.skills_tokens > 0 && (
                    <TableRow>
                      <TableCell>Skills Instructions</TableCell>
                      <TableCell align="right">{breakdownData.skills_tokens.toLocaleString()}</TableCell>
                    </TableRow>
                  )}
                  {breakdownData.tools_guidance_tokens > 0 && (
                    <TableRow>
                      <TableCell>Tools Guidance</TableCell>
                      <TableCell align="right">{breakdownData.tools_guidance_tokens.toLocaleString()}</TableCell>
                    </TableRow>
                  )}
                  {breakdownData.sub_agents_tokens > 0 && (
                    <TableRow>
                      <TableCell>Sub-Agent Delegation Guide</TableCell>
                      <TableCell align="right">{breakdownData.sub_agents_tokens.toLocaleString()}</TableCell>
                    </TableRow>
                  )}
                  <TableRow>
                    <TableCell>Message History ({breakdownData.message_count} msgs)</TableCell>
                    <TableCell align="right">{breakdownData.message_history_tokens.toLocaleString()}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Tool Schemas ({breakdownData.tool_count} tools)</TableCell>
                    <TableCell align="right">{breakdownData.tool_schemas_tokens.toLocaleString()}</TableCell>
                  </TableRow>
                  <TableRow sx={{ '& td': { fontWeight: 600 } }}>
                    <TableCell>Total</TableCell>
                    <TableCell align="right">{breakdownData.total_tokens.toLocaleString()}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>

              {/* Loaded skills */}
              {breakdownData.loaded_skills.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" gutterBottom>Loaded Skills</Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {breakdownData.loaded_skills.map((skill) => (
                      <Chip key={skill} label={skill} size="small" variant="outlined" />
                    ))}
                  </Box>
                </Box>
              )}

              {/* Loaded tools */}
              {breakdownData.loaded_tools.length > 0 && (
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Loaded Tools ({breakdownData.loaded_tools.length})
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, maxHeight: 120, overflowY: 'auto' }}>
                    {breakdownData.loaded_tools.map((tool) => (
                      <Chip key={tool} label={tool} size="small" variant="outlined" />
                    ))}
                  </Box>
                </Box>
              )}

              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
                Token estimates based on word count × 1.3
              </Typography>
            </Box>
          ) : (
            <Typography color="text.secondary">
              {currentConversation
                ? 'No breakdown yet — send a message to populate the context.'
                : 'Select a conversation to see context breakdown.'}
            </Typography>
          )}
        </DialogContent>
      </Dialog>

      {/* Resume picker — full-pane overlay, dismiss with Esc */}
      {resumeDialogOpen && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 5,
            bgcolor: 'background.default',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}>
            <Box>
              <Typography variant="h6">Resume Conversation</Typography>
              <Typography variant="caption" color="text.secondary">
                Press Esc to cancel
              </Typography>
            </Box>
            <IconButton size="small" onClick={() => setResumeDialogOpen(false)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {resumeLoading ? (
              <Box sx={{ p: 4 }}>
                <LinearProgress />
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'center' }}>
                  Loading conversations...
                </Typography>
              </Box>
            ) : resumeConversations.length === 0 ? (
              <Typography color="text.secondary" sx={{ p: 4, textAlign: 'center' }}>
                No previous conversations.
              </Typography>
            ) : (
              <List disablePadding>
                {resumeConversations.map((conv, idx) => {
                  const isCurrent = conv.id === currentConversation?.id;
                  const isActive = idx === resumeActiveIdx;
                  const updated = conv.updated_at ? new Date(conv.updated_at).toLocaleString() : '';
                  const preview = conv.last_message?.content?.slice(0, 80) || '';
                  return (
                    <React.Fragment key={conv.id}>
                      {idx > 0 && <Divider component="li" />}
                      <ListItemButton
                        onClick={() => handleResumeSelect(conv)}
                        onMouseEnter={() => setResumeActiveIdx(idx)}
                        selected={isCurrent}
                        ref={(el) => {
                          if (isActive && el) el.scrollIntoView({ block: 'nearest' });
                        }}
                        sx={{
                          py: 1.25,
                          px: 3,
                          ...(isActive && { bgcolor: 'action.hover' }),
                        }}
                      >
                        <ListItemText
                          primary={
                            <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2 }}>
                              <Typography variant="body2" sx={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {conv.title || 'Untitled'}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                                {updated}
                              </Typography>
                            </Box>
                          }
                          secondary={preview && (
                            <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                              {preview}
                            </Typography>
                          )}
                        />
                      </ListItemButton>
                    </React.Fragment>
                  );
                })}
              </List>
            )}
          </Box>
        </Box>
      )}

      {/* Persona sheet — full-pane overlay, dismiss with Esc. A per-conversation
          override: picking someone rebinds the open conversation. */}
      {personaSheetOpen && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 5,
            bgcolor: 'background.default',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}>
            <Box>
              <Typography variant="h6">Who should answer?</Typography>
              <Typography variant="caption" color="text.secondary">
                {currentConversation
                  ? 'Switches the persona for this conversation. Press Esc to cancel.'
                  : 'Press Esc to cancel'}
              </Typography>
            </Box>
            <IconButton size="small" onClick={() => setPersonaSheetOpen(false)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
          {personaSheetError && (
            <Alert severity="error" sx={{ m: 2 }} onClose={() => setPersonaSheetError('')}>
              {personaSheetError}
            </Alert>
          )}
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {selectablePersonas.length === 0 ? (
              <Typography color="text.secondary" sx={{ p: 4, textAlign: 'center' }}>
                No personas available.
              </Typography>
            ) : (
                <List disablePadding>
                  {selectablePersonas.map((persona, idx) => {
                    const isCurrent = persona.id === activePersonaId;
                    const isActive = idx === personaActiveIdx;
                    return (
                      <React.Fragment key={persona.id}>
                        {idx > 0 && <Divider component="li" />}
                        <ListItemButton
                          onClick={() => { void handlePersonaPick(persona.id); }}
                          onMouseEnter={() => setPersonaActiveIdx(idx)}
                          selected={isCurrent}
                          ref={(el) => {
                            if (isActive && el) el.scrollIntoView({ block: 'nearest' });
                          }}
                          sx={{
                            py: 1.25,
                            px: 3,
                            gap: 1.5,
                            ...(isActive && { bgcolor: 'action.hover' }),
                          }}
                        >
                          <Avatar
                            src={persona.avatar_uuid ? apiClient.getImageUrl(persona.avatar_uuid) : undefined}
                            sx={{
                              width: 40,
                              height: 40,
                              bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'),
                              flexShrink: 0,
                            }}
                          >
                            {!persona.avatar_uuid && (
                              <SmartToyIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                            )}
                          </Avatar>
                          <ListItemText
                            primary={
                              <Typography variant="body2" sx={{ fontWeight: isCurrent ? 600 : 500 }}>
                                {persona.name}
                              </Typography>
                            }
                            secondary={persona.description ? (
                              <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                                {persona.description}
                              </Typography>
                            ) : null}
                          />
                        </ListItemButton>
                      </React.Fragment>
                    );
                  })}
                </List>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};
