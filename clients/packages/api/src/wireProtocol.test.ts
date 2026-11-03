import { describe, it, expect } from 'vitest';
import { describeMismatch, mismatchSide } from './wireProtocol';
import { webSocketProtocols } from './websocket';
import {
  LEGACY_WS_AUTH_SUBPROTOCOL,
  LEGACY_WS_WIRE_SUBPROTOCOL_PREFIX,
  WIRE_PROTOCOL,
  WS_AUTH_SUBPROTOCOL,
  WS_WIRE_SUBPROTOCOL_PREFIX,
} from '@amadeus/models';

describe('browser WebSocket rename compatibility', () => {
  it('offers the Amadeus handshake, and can retry the exact older-server one', () => {
    expect(webSocketProtocols('token')).toEqual([
      WS_AUTH_SUBPROTOCOL,
      'token',
      `${WS_WIRE_SUBPROTOCOL_PREFIX}${WIRE_PROTOCOL}`,
    ]);
    expect(webSocketProtocols('token', true)).toEqual([
      LEGACY_WS_AUTH_SUBPROTOCOL,
      'token',
      `${LEGACY_WS_WIRE_SUBPROTOCOL_PREFIX}${WIRE_PROTOCOL}`,
    ]);
  });

  it('never repeats an entry, which a browser refuses outright', () => {
    for (const legacyOnly of [false, true]) {
      const offered = webSocketProtocols('token', legacyOnly);
      expect(new Set(offered).size).toBe(offered.length);
    }
  });
});

describe('wire-protocol mismatch copy', () => {
  it('tells the user to update the app when the server is ahead', () => {
    expect(mismatchSide(5, 6)).toBe('app');
    expect(describeMismatch(5, 6)).toBe(
      'This app speaks wire protocol 5 but the server speaks 6. Update the app.',
    );
  });

  it('tells the user the server is behind when the app is ahead', () => {
    expect(mismatchSide(5, 4)).toBe('server');
    expect(describeMismatch(5, 4)).toBe(
      'This app speaks wire protocol 5 but the server speaks 4. Ask the operator to update the server.',
    );
  });

  it('does not guess a side when the server number is unknown', () => {
    expect(mismatchSide(5, null)).toBe('unknown');
    expect(mismatchSide(5, Number.NaN)).toBe('unknown');
    const copy = describeMismatch(5, null);
    expect(copy).toContain('wire protocol 5');
    expect(copy).not.toContain('Update the app.');
    expect(copy).not.toContain('update the server');
  });
});
