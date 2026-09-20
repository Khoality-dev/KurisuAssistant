import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { HOST_MESSAGE_TYPES, HostMessageError, parseHostMessage } from './host';

const FIXTURES = join(dirname(new URL(import.meta.url).pathname), 'fixtures');

describe('parseHostMessage', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

  it('has a golden fixture for every message type', () => {
    const types = new Set(files.map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')).t));
    for (const t of HOST_MESSAGE_TYPES) expect(types.has(t), `no fixture for ${t}`).toBe(true);
  });

  it.each(files)('decodes %s from a JSON string and from an object alike', (file) => {
    const text = readFileSync(join(FIXTURES, file), 'utf8');
    const fromString = parseHostMessage(text);
    const fromObject = parseHostMessage(JSON.parse(text));
    expect(fromString).toEqual(fromObject);
    expect(fromString.t).toBe(JSON.parse(text).t);
  });

  it('parses the config fixture into a typed character', () => {
    const m = parseHostMessage(readFileSync(join(FIXTURES, 'config.json'), 'utf8'));
    if (m.t !== 'config') throw new Error('wrong type');
    expect(m.character?.kind).toBe('vrm');
    expect(m.character?.vrm?.model?.sha256).toHaveLength(64);
    expect(m.personaName).toBe('Kurisu');
  });

  it('clamps a speech curve into 0..1 and keeps its cues', () => {
    const m = parseHostMessage({ t: 'speech', segment: { text: 'x', startedAt: 1, durationMs: 100, windowMs: 33, curve: [-1, 0.5, 2], cues: [{ emotion: 'happy', delayMs: 10 }] } });
    if (m.t !== 'speech') throw new Error('wrong type');
    expect(m.segment?.curve).toEqual([0, 0.5, 1]);
    expect(m.segment?.cues).toEqual([{ emotion: 'happy', delayMs: 10 }]);
  });

  it.each([
    ['not json', 'not json'],
    ['no type', {}],
    ['unknown type', { t: 'dance' }],
    ['bad emotion', { t: 'resting', emotion: 'excited' }],
    ['bad gestures', { t: 'gestures', names: [1], seq: 0 }],
    ['bad feed', { t: 'feed', isThinking: 'yes' }],
    ['bad segment', { t: 'speech', segment: { text: 'x' } }],
    ['bad sync', { t: 'speech-sync', sync: { positionMs: 'a', at: 1 } }],
  ])('refuses %s with a HostMessageError', (_name, raw) => {
    expect(() => parseHostMessage(raw)).toThrow(HostMessageError);
  });

  it('accepts a null config and a null segment', () => {
    expect(parseHostMessage({ t: 'config', character: null })).toEqual({ t: 'config', character: null, personaName: null });
    expect(parseHostMessage({ t: 'speech', segment: null })).toEqual({ t: 'speech', segment: null });
  });
});
