/**
 * The sentence shown when a speech request fails (#200).
 *
 * Synthesis responses are blobs, so the API's `detail` arrives inside a Blob and
 * must still come out as the message; a dead server must read as unreachable,
 * not as an axios error string.
 */

import { describe, expect, it } from 'vitest';
import { describeSpeechFailure } from './speechErrors';

describe('describeSpeechFailure', () => {
  it('uses the API detail when the body is JSON', async () => {
    const err = { response: { status: 502, data: { detail: 'The speech service is unavailable.' } } };
    expect(await describeSpeechFailure('Speech', err)).toBe('Speech failed: The speech service is unavailable.');
  });

  it('reads the API detail out of a Blob body', async () => {
    const blob = new Blob([JSON.stringify({ detail: 'The speech service is unavailable.' })], { type: 'application/json' });
    const err = { response: { status: 502, data: blob } };
    expect(await describeSpeechFailure('Speech', err)).toBe('Speech failed: The speech service is unavailable.');
  });

  it('falls back to the status when the body says nothing useful', async () => {
    const err = { response: { status: 500, data: new Blob(['not json']) } };
    expect(await describeSpeechFailure('Transcription', err)).toBe('Transcription failed: the server answered 500.');
  });

  it('names an unreachable server without quoting axios', async () => {
    const err = { request: {}, message: 'Network Error', code: 'ERR_NETWORK' };
    expect(await describeSpeechFailure('Speech', err)).toBe('Speech failed: the server could not be reached.');
  });

  it('has something to say for an unknown error', async () => {
    expect(await describeSpeechFailure('Speech', undefined)).toBe('Speech failed: something went wrong.');
    expect(await describeSpeechFailure('Speech', new Error('boom'))).toBe('Speech failed: boom.');
  });
});
