/**
 * Every event name, as runtime data so it can be checked rather than trusted.
 *
 * These were retyped by hand from the backend's `websocket/events.py`, and the
 * copies drifted: `compact_context` was missing here while `commands.ts` was
 * sending it. The names now live in one array, the union type is derived from
 * it, and `protocol.test.ts` compares the array against `protocol/events.json`,
 * which the backend generates (#93). `vision_frame` is absent on purpose — a
 * webcam frame is a binary message with its own envelope (#111).
 */
export const CLIENT_TO_SERVER_EVENTS = [
  'chat_request',
  'tool_approval_response',
  'cancel',
  'vision_start',
  'vision_stop',
  'client_tools_register',
  'tool_call_response',
  'compact_context',
] as const;

export const SERVER_TO_CLIENT_EVENTS = [
  'connected',
  'stream_chunk',
  'tool_approval_request',
  'tool_call_request',
  'done',
  'error',
  'vision_result',
  'context_info',
] as const;

export const EVENT_TYPES = [...CLIENT_TO_SERVER_EVENTS, ...SERVER_TO_CLIENT_EVENTS] as const;

export type ClientToServerEventType = (typeof CLIENT_TO_SERVER_EVENTS)[number];
export type ServerToClientEventType = (typeof SERVER_TO_CLIENT_EVENTS)[number];
export type EventType = (typeof EVENT_TYPES)[number];
