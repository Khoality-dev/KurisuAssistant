/**
 * The binary envelope, checked against the layout the backend parses.
 *
 * Frames used to be base64 JPEG inside JSON on the chat socket (#111); these
 * assert the bytes now leave in the shape `websocket/binary.py` expects.
 */

import { describe, it, expect } from 'vitest';
import {
  BINARY_PROTOCOL_VERSION,
  BinaryMessageType,
  HEADER_PREFIX_BYTES,
  MAX_HEADER_BYTES,
  encodeVisionFrame,
} from './binaryFrame';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

/** The server's parse, in miniature. */
function decode(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const headerLength = view.getUint16(2, false);
  const header = new TextDecoder().decode(
    bytes.slice(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + headerLength),
  );
  return {
    version: view.getUint8(0),
    type: view.getUint8(1),
    header: JSON.parse(header),
    payload: bytes.slice(HEADER_PREFIX_BYTES + headerLength),
  };
}

describe('encodeVisionFrame', () => {
  it('writes the version, the type and a big-endian header length', () => {
    const decoded = decode(encodeVisionFrame(JPEG, { event_id: 'abc' }));
    expect(decoded.version).toBe(BINARY_PROTOCOL_VERSION);
    expect(decoded.type).toBe(BinaryMessageType.VISION_FRAME);
    expect(decoded.header).toEqual({ event_id: 'abc' });
  });

  it('carries the JPEG bytes unchanged, with no base64 step', () => {
    const buffer = encodeVisionFrame(JPEG);
    const decoded = decode(buffer);
    expect(Array.from(decoded.payload)).toEqual(Array.from(JPEG));
    // Header is "{}" — two bytes — so the message is the frame plus 6.
    expect(buffer.byteLength).toBe(HEADER_PREFIX_BYTES + 2 + JPEG.length);
  });

  it('keeps a multi-byte header length correct', () => {
    const long = 'x'.repeat(400);
    const decoded = decode(encodeVisionFrame(JPEG, { event_id: long }));
    expect(decoded.header.event_id).toBe(long);
    expect(Array.from(decoded.payload)).toEqual(Array.from(JPEG));
  });

  it('refuses a header the server would refuse', () => {
    expect(() => encodeVisionFrame(JPEG, { event_id: 'x'.repeat(MAX_HEADER_BYTES) })).toThrow(
      /over/,
    );
  });
});
