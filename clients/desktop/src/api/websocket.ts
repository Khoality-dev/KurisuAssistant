/**
 * WebSocket manager for real-time chat communication.
 */

import { config } from '../config';

// Event types matching backend websocket/events.py
export type EventType =
  | 'chat_request'
  | 'tool_approval_response'
  | 'cancel'
  | 'stream_chunk'
  | 'tool_approval_request'
  | 'agent_switch'
  | 'done'
  | 'error'
  | 'reconnected';

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

export type ServerEvent =
  | StreamChunkEvent
  | AgentSwitchEvent
  | DoneEvent
  | ErrorEvent
  | ToolApprovalRequestEvent;

type EventHandler<T = ServerEvent> = (event: T) => void;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private handlers: Map<EventType, Set<EventHandler>> = new Map();
  private connectionPromise: Promise<void> | null = null;
  private isConnecting = false;
  private lastConnectedAt = 0;

  /**
   * Set the authentication token.
   */
  setToken(token: string) {
    this.token = token;
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
    this.connectionPromise = new Promise((resolve, reject) => {
      // Convert http(s) to ws(s)
      const wsUrl = config.apiBaseUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:');

      const url = `${wsUrl}/ws/chat?token=${encodeURIComponent(this.token!)}`;
      console.log('[WebSocket] Connecting to:', url.replace(this.token!, '***'));

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected');
        this.lastConnectedAt = Date.now();
        // Only reset reconnect counter if connection was stable (>10s)
        // This prevents infinite reconnect loops when server accepts then drops
        if (this.reconnectAttempts > 0) {
          // Will be reset on next successful message or after stable period
          setTimeout(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.reconnectAttempts = 0;
            }
          }, 10000);
        }
        this.isConnecting = false;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          console.log('[WebSocket] Received:', data.type, data);
          this.dispatchEvent(data);
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
        console.log('[WebSocket] Closed:', event.code, event.reason);
        this.isConnecting = false;
        this.ws = null;
        this.connectionPromise = null;

        // Attempt reconnection if not intentional close
        if (event.code !== 1000 && event.code !== 4001) {
          // Notify handlers so streaming UI can clean up
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
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect after intentional disconnect
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connectionPromise = null;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Send an event to the server.
   */
  send(event: Partial<ChatRequestEvent> | Partial<CancelEvent>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const fullEvent = {
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    console.log('[WebSocket] Sending:', fullEvent.type, fullEvent);
    this.ws.send(JSON.stringify(fullEvent));
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
   * Send a cancel request.
   */
  sendCancel() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'cancel' });
    }
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
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WebSocket] Max reconnect attempts reached, giving up');
      this.dispatchEvent({
        type: 'error',
        error: 'Connection lost. Please refresh the page.',
        code: 'MAX_RECONNECT',
        event_id: '',
        timestamp: new Date().toISOString(),
      } as ErrorEvent);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (this.token && !this.isConnected()) {
        this.connect()
          .then(() => {
            console.log('[WebSocket] Reconnected successfully');
            this.dispatchEvent({
              type: 'reconnected',
              event_id: '',
              timestamp: new Date().toISOString(),
            } as BaseEvent & { type: 'reconnected' });
          })
          .catch(console.error);
      }
    }, delay);
  }
}

export const wsManager = new WebSocketManager();
