import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box,
  IconButton,
  Typography,
  Tooltip,
  Snackbar,
  Alert,
} from '@mui/material';
import {
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import { AnimatePresence } from 'framer-motion';
import { useConversationStore } from '../../store/conversationStore';
import { storage } from '../../utils/storage';
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

  const [showAdministrator, setShowAdministrator] = useState<boolean>(storage.getShowAdministrator());

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
    showAdministrator,
    queueText,
    clearQueue,
    amplitudeRef,
    pushAgentCharacterConfig,
  });

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

  const toggleShowAdministrator = useCallback(() => {
    const newValue = !showAdministrator;
    setShowAdministrator(newValue);
    storage.setShowAdministrator(newValue);
  }, [showAdministrator]);

  // Message rendering
  const messageElements = useMemo(() => {
    const combined = [...messages, ...streaming.streamingMessages];
    const activeStreamingMsg = streaming.isStreaming && streaming.streamingMessages.length > 0
      ? streaming.streamingMessages[streaming.streamingMessages.length - 1]
      : null;
    const filtered = combined.filter((message) => {
      const speakerName = message.name || message.agent?.name;
      if (speakerName === 'Administrator' && !showAdministrator) {
        return false;
      }
      return true;
    });

    const elements: React.ReactNode[] = [];
    let lastFrameId: number | undefined;

    filtered.forEach((message, index) => {
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
      elements.push(
        <MessageBubble
          key={message.id ? `msg-${message.id}` : `stream-${index}`}
          message={message}
          index={index}
          isLast={index === filtered.length - 1}
          isStreaming={isActiveStreaming}
          streamingThinking={isActiveStreaming ? streaming.streamingThinking : ''}
          streamingContent={isActiveStreaming ? streaming.streamingContent : ''}
          displayedThinking={isActiveStreaming ? streaming.streamingThinking : ''}
          displayedContent={isActiveStreaming ? streaming.streamingContent : ''}
          justFinishedStreaming={index === filtered.length - 1 && streaming.justFinishedStreaming}
          expandedThinking={streaming.expandedThinking}
          onToggleThinking={streaming.toggleThinking}
          onResend={streaming.handleResend}
          onDelete={streaming.handleDelete}
          ttsRef={ttsRef}
        />
      );
    });

    return elements;
  }, [
    messages,
    streaming.streamingMessages,
    streaming.isStreaming,
    showAdministrator,
    frames,
    streaming.streamingThinking,
    streaming.streamingContent,
    streaming.justFinishedStreaming,
    streaming.expandedThinking,
    streaming.toggleThinking,
    streaming.handleResend,
    streaming.handleDelete,
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
      {!agentId && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
          <Tooltip title={showAdministrator ? 'Hide Administrator messages' : 'Show Administrator messages'}>
            <IconButton
              size="small"
              onClick={toggleShowAdministrator}
              sx={{ opacity: 0.6, '&:hover': { opacity: 1 } }}
            >
              {showAdministrator ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
      )}

      {isLoadingMessages && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Loading earlier messages...
          </Typography>
        </Box>
      )}

      <AnimatePresence>
        {messageElements}
      </AnimatePresence>
      <div ref={streaming.messagesEndRef} />
    </Box>
  ), [agentId, isLoadingMessages, messageElements, showAdministrator, toggleShowAdministrator]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%' }}>

      {messagesPane}

      {/* Selection context chips — above input */}
      <SelectionChips />

      {/* Bottom area: interactive call bar or typing input */}
      {asr.interactiveMode ? (
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
    </Box>
  );
};
