/**
 * The binary envelope webcam frames travel in.
 *
 * Mirrors `backend/kurisuassistant/websocket/binary.py`. A frame used to be
 * base64 JPEG inside a JSON event on the chat socket, so every frame cost a
 * third extra on the wire, a JSON parse on the server, and — the reason this
 * exists — a place in the send buffer ahead of the assistant's next token (#111).
 *
 *   0        1        2                 4              4+H
 *   +--------+--------+-----------------+---------------+------------------+
 *   | version| type   | header length   | header (JSON) | payload (bytes)  |
 *   | uint8  | uint8  | uint16 big-end. | UTF-8, H long | JPEG             |
 *   +--------+--------+-----------------+---------------+------------------+
 *
 * If a field here disagrees with the backend, the backend wins — fix this file.
 */

/** The envelope's own version, not the wire protocol. */
export const BINARY_PROTOCOL_VERSION = 1;

export const BinaryMessageType = {
  VISION_FRAME: 1,
} as const;

export type BinaryMessageType = (typeof BinaryMessageType)[keyof typeof BinaryMessageType];

/** version + type + header length. */
export const HEADER_PREFIX_BYTES = 4;

/** The server refuses anything larger. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_HEADER_BYTES = 4096;

export interface BinaryHeader {
  event_id?: string;
  timestamp?: string;
}

/**
 * Build one binary message. Throws if the header is over the server's cap,
 * which would be refused on arrival.
 */
export function encodeBinaryMessage(
  messageType: BinaryMessageType,
  payload: Uint8Array,
  header: BinaryHeader = {},
): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error(`Binary header is ${headerBytes.length} bytes, over ${MAX_HEADER_BYTES}`);
  }

  const buffer = new ArrayBuffer(HEADER_PREFIX_BYTES + headerBytes.length + payload.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, BINARY_PROTOCOL_VERSION);
  view.setUint8(1, messageType);
  view.setUint16(2, headerBytes.length, false); // big-endian, as the server reads it
  bytes.set(headerBytes, HEADER_PREFIX_BYTES);
  bytes.set(payload, HEADER_PREFIX_BYTES + headerBytes.length);

  return buffer;
}

/** A webcam frame, ready for `WebSocket.send`. */
export function encodeVisionFrame(jpeg: Uint8Array, header: BinaryHeader = {}): ArrayBuffer {
  return encodeBinaryMessage(BinaryMessageType.VISION_FRAME, jpeg, header);
}
