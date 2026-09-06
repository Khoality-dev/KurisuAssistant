/**
 * This client's protocol constants must match the backend's (#93).
 *
 * The event names and the wire-protocol integer were retyped by hand from
 * `backend/kurisuassistant/websocket/events.py` and `version.py`, and nothing
 * checked that the copies agreed. They did not: `compact_context` was missing
 * from the union while `commands.ts` was sending it, and on two occasions two
 * open pull requests each claimed the same protocol number.
 *
 * `protocol/events.json` is generated from the backend. This reads it and fails
 * when this package drifts — in this package's own CI job, which is the one that
 * runs when someone edits this package.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  CLIENT_TO_SERVER_EVENTS,
  EVENT_TYPES,
  SERVER_TO_CLIENT_EVENTS,
} from './events';
import { WIRE_PROTOCOL } from './constants';

interface Manifest {
  wire_protocol: number;
  events: Record<string, { direction: 'client_to_server' | 'server_to_client'; transport: 'json' | 'binary' }>;
}

/** Walk up to the repository root, so the path survives being run from anywhere. */
function loadManifest(): Manifest {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    try {
      return JSON.parse(readFileSync(join(dir, 'protocol', 'events.json'), 'utf8'));
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('protocol/events.json not found — the backend generates it');
}

const manifest = loadManifest();

const named = (direction: string, transport = 'json') =>
  Object.entries(manifest.events)
    .filter(([, e]) => e.direction === direction && e.transport === transport)
    .map(([name]) => name)
    .sort();

describe('the protocol this client speaks', () => {
  it('sends exactly the events the backend accepts over JSON', () => {
    expect([...CLIENT_TO_SERVER_EVENTS].sort()).toEqual(named('client_to_server'));
  });

  it('handles exactly the events the backend sends', () => {
    expect([...SERVER_TO_CLIENT_EVENTS].sort()).toEqual(named('server_to_client'));
  });

  it('claims the same wire protocol as the backend', () => {
    expect(WIRE_PROTOCOL).toBe(manifest.wire_protocol);
  });

  it('does not treat a binary message as a JSON event', () => {
    // A webcam frame has its own envelope and never reaches the JSON dispatch
    // (#111); listing it here would invite someone to send it as JSON again.
    const binary = Object.entries(manifest.events)
      .filter(([, e]) => e.transport === 'binary')
      .map(([name]) => name);
    expect(binary).toContain('vision_frame');
    for (const name of binary) {
      expect(EVENT_TYPES).not.toContain(name);
    }
  });
});
