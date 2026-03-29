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
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

import { AnimatePresence } from 'framer-motion';
import { useConversationStore } from '../../store/conversationStore';
import { useAuthStore } from '../../store/authStore';

import { useTTS } from '../../hooks/useTTS';
import { useVisionStore } from '../../store/visionStore';
import { useCharacterPanel } from '../../hooks/useCharacterPanel';
import { useInteractiveASR } from '../../hooks/useInteractiveASR';
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

export const ChatWidget: React.FC<ChatWidgetProps> = ({ characterWindowOpen = false, agentId = null }) => {
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
    clearExternalDraft: streaming.clearExternalDraft,
  });

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

  // Token count: backend value during streaming, frontend estimate at rest
  const estimatedTokens = useMemo(() => {
    const contextMsgs = messages.filter(m => (m.id ?? Infinity) > compactedUpToId);
    const wc = (t: string | undefined) => t ? t.split(/\s+/).length : 0;
    const msgWords = contextMsgs.reduce((n, m) => n + wc(m.content) + wc(m.thinking), 0);
    const contextWords = wc(compactedContext);
    return Math.round((msgWords + contextWords) * 1.3);
  }, [messages, compactedUpToId, compactedContext]);

  const tokenCount = estimatedTokens;

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
      elements.push(
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
          ttsRef={ttsRef}
        />
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
          <Typography variant="caption" color="text.secondary">
            {tokenCount.toLocaleString()} / {contextSize.toLocaleString()} tokens
          </Typography>
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
      ) : asr.interactiveMode ? (
        <InteractiveCallBar
          asrStatus={asr.asrStatus}
          interactionActive={asr.interactionActive}
          lastTranscript={asr.lastTranscript}
          isStreaming={streaming.isStreaming}
          isTTSPlaying={isQueueActive}
          onHangUp={asr.disableInteractiveMode}
        />
      ) : (
        <ChatComposer
          scopeKey={`${agentId ?? 'group'}:${streaming.activeConversationId ?? 'new'}`}
          externalDraft={streaming.externalDraft}
          externalDraftVersion={streaming.externalDraftVersion}
          isStreaming={streaming.isStreaming}
          asrStatus={asr.asrStatus}
          asrDevices={asr.asrDevices}
          asrDeviceId={asr.asrDeviceId}
          micMenuAnchor={asr.micMenuAnchor}
          cameraActive={cameraActive}
          cameraWebcams={cameraWebcams}
          cameraSelectedWebcam={cameraSelectedWebcam}
          cameraMenuAnchor={cameraMenuAnchor}
          onSend={streaming.handleSend}
          onCancel={streaming.handleCancel}
          onMicToggle={asr.handleMicToggle}
          onMicContext={asr.handleMicContext}
          onCloseMicMenu={asr.closeMicMenu}
          onSelectAsrDevice={asr.selectAsrDevice}
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
