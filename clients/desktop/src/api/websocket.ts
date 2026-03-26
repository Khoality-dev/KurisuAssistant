/**
 * WebSocket manager for real-time chat communication.
 */

import { config } from '../config';

// Event types matching backend websocket/events.py
export type EventType =
  | 'chat_request'
  | 'tool_approval_response'
  | 'cancel'
  | 'vision_start'
  | 'vision_stop'
  | 'client_tools_register'
  | 'tool_call_response'
  | 'stream_chunk'
  | 'tool_approval_request'
  | 'tool_call_request'
  | 'agent_switch'
  | 'done'
  | 'error'
  | 'vision_result'
  | 'media_state'
  | 'media_chunk'
  | 'media_error'
  | 'connected';

// Base event interface
export interface BaseEvent {
  type: EventType;
  event_id: string;
  timestamp: string;
}

// Client -> Server events
export interface ChatRequestEvent extends BaseEvent {
  type: 'chat_request';
  text: string;
  model_name: string;
  conversation_id: number | null;
  agent_id: number | null;
  images: string[]; // base64 encoded
}

export interface CancelEvent extends BaseEvent {
  type: 'cancel';
}

export interface VisionStartEvent extends BaseEvent {
  type: 'vision_start';
}

export interface VisionStopEvent extends BaseEvent {
  type: 'vision_stop';
}

// Server -> Client events
export interface StreamChunkEvent extends BaseEvent {
  type: 'stream_chunk';
  content: string;
  thinking: string | null;
  role: string;
  agent_id: number | null;
  name: string | null;
  voice_reference: string | null;
  model_name: string | null;
  provider_type: string | null;
  tool_args: Record<string, unknown> | null;
  conversation_id: number;
  frame_id: number;
  images: string[] | null;
}

export interface AgentSwitchEvent extends BaseEvent {
  type: 'agent_switch';
  from_agent_id: number | null;
  from_agent_name: string | null;
  to_agent_id: number | null;
  to_agent_name: string | null;
  reason: string;
}

export interface DoneEvent extends BaseEvent {
  type: 'done';
  conversation_id: number;
  frame_id: number;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  error: string;
  code: string;
}

export interface ToolApprovalRequestEvent extends BaseEvent {
  type: 'tool_approval_request';
  approval_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  agent_id: number | null;
  name: string | null;
  description: string;
  risk_level: string;
}

export interface VisionResultEvent extends BaseEvent {
  type: 'vision_result';
  faces: Array<{
    identity_id: number | null;
    name: string;
    confidence: number;
    bbox: number[];
  }>;
  gestures: Array<{
    gesture: string;
    confidence: number;
  }>;
}

export interface MediaStateEvent extends BaseEvent {
  type: 'media_state';
  state: 'stopped' | 'playing' | 'paused';
  current_track: {
    title: string;
    url: string;
    duration: number | null;
    thumbnail: string | null;
    artist: string | null;
  } | null;
  queue: Array<{
    title: string;
    url: string;
    duration: number | null;
    thumbnail: string | null;
    artist: string | null;
  }>;
  volume: number;
}

export interface MediaChunkEvent extends BaseEvent {
  type: 'media_chunk';
  data: string; // base64 encoded audio
  chunk_index: number;
  is_last: boolean;
  format: string;
  sample_rate: number;
}

export interface MediaErrorEvent extends BaseEvent {
  type: 'media_error';
  error: string;
}

// Server -> Client: tool call forwarding
export interface ToolCallRequestEvent extends BaseEvent {
  type: 'tool_call_request';
  request_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
}

export interface ConnectedEvent extends BaseEvent {
  type: 'connected';
  chat_active: boolean;
  conversation_id: number | null;
  frame_id: number | null;
  media_state: {
    state: 'stopped' | 'playing' | 'paused';
    current_track: MediaStateEvent['current_track'];
    queue: MediaStateEvent['queue'];
    volume: number;
  } | null;
  vision_active: boolean;
  vision_config: {
    enable_face: boolean;
    enable_pose: boolean;
    enable_hands: boolean;
  } | null;
}

export type ServerEvent =
  | ConnectedEvent
  | StreamChunkEvent
  | AgentSwitchEvent
  | DoneEvent
  | ErrorEvent
  | ToolApprovalRequestEvent
  | ToolCallRequestEvent
  | VisionResultEvent
  | MediaStateEvent
  | MediaChunkEvent
  | MediaErrorEvent;

type EventHandler<T = ServerEvent> = (event: T) => void;

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
type StatusHandler = (status: ConnectionStatus) => void;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private handlers: Map<EventType, Set<EventHandler>> = new Map();
  private connectionPromise: Promise<void> | null = null;
  private isConnecting = false;
  private _connectionStatus: ConnectionStatus = 'disconnected';
  private _statusHandlers: Set<StatusHandler> = new Set();
  private _pendingMessages: string[] = [];
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempt = 0;
  private _maxReconnectDelay = 30000; // 30s cap
  private _intentionalClose = false;

  /**
   * Set the authentication token.
   */
  setToken(token: string) {
    this.token = token;
    // Eagerly connect on token set (login/restore)
    this.connect().catch(() => {});
  }

  /**
   * Clear the authentication token and stop reconnection.
   */
  clearToken() {
    this.token = null;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempt = 0;
  }

  /**
   * Connect to the WebSocket server.
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    if (!this.token) {
      throw new Error('No authentication token set');
    }

    this._intentionalClose = false;
    this.isConnecting = true;
    this.setStatus('connecting');
    this.connectionPromise = new Promise((resolve, reject) => {
      // Convert http(s) to ws(s)
      const wsUrl = config.apiBaseUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:');

      const url = `${wsUrl}/ws/chat?token=${encodeURIComponent(this.token!)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this._reconnectAttempt = 0;
        this.setStatus('connected');

        // Flush queued messages
        for (const msg of this._pendingMessages) {
          try {
            this.ws?.send(msg);
          } catch (e) {
            console.error('[WebSocket] Failed to flush queued message:', e);
          }
        }
        this._pendingMessages = [];

        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Respond to server heartbeat pings
          if (data.type === 'ping') {
            this.ws?.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          this.dispatchEvent(data as ServerEvent);
        } catch (e) {
          console.error('[WebSocket] Failed to parse message:', e);
        }
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        this.isConnecting = false;
        reject(error);
      };

      this.ws.onclose = (event) => {
        this.isConnecting = false;
        this.ws = null;
        this.connectionPromise = null;
        this.setStatus('disconnected');

        if (event.code === 4001) {
          // Auth failure — try refresh then reconnect
          this._handleAuthFailure();
          return;
        }

        // Auto-reconnect on unexpected close (not intentional disconnect)
        if (!this._intentionalClose && this.token) {
          this._scheduleReconnect();
        }
      };
    });

    return this.connectionPromise;
  }

  private _scheduleReconnect() {
    if (this._reconnectTimer) return;
    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempt), this._maxReconnectDelay);
    this._reconnectAttempt++;
    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  private async _handleAuthFailure() {
    try {
      // Dynamic import to avoid circular dependency
      const { apiClient } = await import('./client');
      await apiClient.tryRefresh();
      // tryRefresh calls wsManager.setToken which triggers connect()
    } catch {
      console.error('[WebSocket] Token refresh failed, auth required');
    }
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempt = 0;
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connectionPromise = null;
    this.isConnecting = false;
    this._pendingMessages = [];
    this.setStatus('disconnected');
  }

  /**
   * Manually reconnect (e.g. user clicks status icon).
   */
  reconnect() {
    if (this.isConnected() || this.isConnecting) return;
    this.connect().catch(() => {});
  }

  /**
   * Send an event to the server.
   */
  send(event: Partial<ChatRequestEvent> | Partial<CancelEvent> | Partial<VisionStartEvent> | Partial<VisionStopEvent> | Record<string, unknown>) {
    const fullEvent = {
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    const json = JSON.stringify(fullEvent);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Don't queue vision frames — they're high-frequency and stale immediately
      if (event.type === 'vision_frame') return;
      this._pendingMessages.push(json);
      return;
    }

    this.ws.send(json);
  }

  /**
   * Send a chat request.
   */
  async sendChatRequest(
    text: string,
    modelName: string,
    conversationId: number | null = null,
    agentId: number | null = null,
    images: string[] = []
  ): Promise<void> {
    // Ensure connected
    await this.connect();

    this.send({
      type: 'chat_request',
      text,
      model_name: modelName,
      conversation_id: conversationId,
      agent_id: agentId,
      images,
    });
  }

  /**
   * Send a vision start request.
   */
  async sendVisionStart(options?: {
    enable_face?: boolean;
    enable_pose?: boolean;
    enable_hands?: boolean;
  }): Promise<void> {
    await this.connect();
    this.send({
      type: 'vision_start',
      enable_face: options?.enable_face ?? true,
      enable_pose: options?.enable_pose ?? true,
      enable_hands: options?.enable_hands ?? true,
    });
  }

  /**
   * Send a webcam frame for inference.
   */
  sendVisionFrame(frameBase64: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'vision_frame', frame: frameBase64 });
    }
  }

  /**
   * Send a vision stop request.
   */
  sendVisionStop() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'vision_stop' });
    }
  }

  /**
   * Send a cancel request.
   */
  sendCancel() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'cancel' });
    }
  }

  sendToolApprovalResponse(approvalId: string, approved: boolean, modifiedArgs?: Record<string, unknown>) {
    this.send({
      type: 'tool_approval_response',
      approval_id: approvalId,
      approved,
      modified_args: modifiedArgs || null,
    });
  }

  // Client-side MCP tool methods

  /**
   * Register client-side tool schemas with the backend.
   */
  sendClientToolsRegister(tools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>) {
    this.send({ type: 'client_tools_register', tools });
  }

  /**
   * Send tool call result back to the backend.
   */
  sendToolCallResponse(requestId: string, content: string, isError: boolean) {
    this.send({ type: 'tool_call_response', request_id: requestId, content, is_error: isError });
  }

  // Media control methods

  async sendMediaPlay(query: string) {
    await this.connect();
    this.send({ type: 'media_play', query });
  }

  async sendMediaPause() {
    await this.connect();
    this.send({ type: 'media_pause' });
  }

  async sendMediaResume() {
    await this.connect();
    this.send({ type: 'media_resume' });
  }

  async sendMediaSkip() {
    await this.connect();
    this.send({ type: 'media_skip' });
  }

  async sendMediaStop() {
    await this.connect();
    this.send({ type: 'media_stop' });
  }

  async sendMediaVolume(volume: number) {
    await this.connect();
    this.send({ type: 'media_volume', volume });
  }

  /**
   * Register an event handler.
   */
  on<T extends ServerEvent>(eventType: EventType, handler: EventHandler<T>) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);
  }

  /**
   * Remove an event handler.
   */
  off<T extends ServerEvent>(eventType: EventType, handler: EventHandler<T>) {
    this.handlers.get(eventType)?.delete(handler as EventHandler);
  }

  /**
   * Remove all handlers for an event type.
   */
  offAll(eventType: EventType) {
    this.handlers.delete(eventType);
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get current connection status.
   */
  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  /**
   * Subscribe to connection status changes.
   */
  onStatusChange(handler: StatusHandler): () => void {
    this._statusHandlers.add(handler);
    return () => this._statusHandlers.delete(handler);
  }

  private setStatus(status: ConnectionStatus) {
    if (this._connectionStatus !== status) {
      this._connectionStatus = status;
      this._statusHandlers.forEach((h) => h(status));
    }
  }

  private dispatchEvent(event: ServerEvent) {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event);
        } catch (e) {
          console.error('[WebSocket] Handler error:', e);
        }
      });
    }
  }

}

export const wsManager = new WebSocketManager();
