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
  | 'stream_chunk'
  | 'tool_approval_request'
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
  conversation_id: number;
  frame_id: number;
  is_replay?: boolean;
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
  is_replay?: boolean;
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
  private reconnectAttempts = 0;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private handlers: Map<EventType, Set<EventHandler>> = new Map();
  private connectionPromise: Promise<void> | null = null;
  private isConnecting = false;
  private lastConnectedAt = 0;
  private intentionalClose = false;
  private _connectionStatus: ConnectionStatus = 'disconnected';
  private _statusHandlers: Set<StatusHandler> = new Set();
  private _pendingMessages: string[] = [];

  /**
   * Set the authentication token.
   */
  setToken(token: string) {
    this.token = token;
    // Eagerly connect on token set (login/restore)
    this.connect().catch(() => {});
  }

  /**
   * Clear the authentication token.
   */
  clearToken() {
    this.token = null;
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

    this.isConnecting = true;
    this.intentionalClose = false;
    this.setStatus('connecting');
    this.connectionPromise = new Promise((resolve, reject) => {
      // Convert http(s) to ws(s)
      const wsUrl = config.apiBaseUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:');

      const url = `${wsUrl}/ws/chat?token=${encodeURIComponent(this.token!)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.lastConnectedAt = Date.now();
        this.reconnectAttempts = 0;
        this.isConnecting = false;
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

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.ws = null;
        this.connectionPromise = null;
        this.setStatus('disconnected');

        if (!this.intentionalClose && this.token) {
          this.dispatchEvent({
            type: 'error',
            error: 'Connection lost. Reconnecting...',
            code: 'CONNECTION_LOST',
            event_id: '',
            timestamp: new Date().toISOString(),
          } as ErrorEvent);
          this.attemptReconnect();
        }
      };
    });

    return this.connectionPromise;
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect() {
    this.intentionalClose = true;
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connectionPromise = null;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this._pendingMessages = [];
    this.setStatus('disconnected');
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

  private attemptReconnect() {
    if (this.intentionalClose || !this.token) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );
    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (this.token && !this.isConnected() && !this.intentionalClose) {
        this.connect()
          .then(() => {
            // Server sends 'connected' event with state snapshot — no synthetic event needed
          })
          .catch(() => {
            this.attemptReconnect();
          });
      }
    }, delay);
  }
}

export const wsManager = new WebSocketManager();
