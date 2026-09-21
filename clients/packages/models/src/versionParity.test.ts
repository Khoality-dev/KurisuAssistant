import { describe, expect, it } from 'vitest';
import { releaseCore, versionMismatchSentence } from './versionParity';

describe('releaseCore', () => {
  it('keeps major.minor.patch and drops the rest', () => {
    expect(releaseCore('0.7.0')).toBe('0.7.0');
    expect(releaseCore('v0.7.0')).toBe('0.7.0');
    expect(releaseCore('0.7.0-dev-a1b2c3d-dirty')).toBe('0.7.0');
    expect(releaseCore('0.7.0+42')).toBe('0.7.0');
  });

  it('is null for nothing and for strings with no release in them', () => {
    expect(releaseCore(null)).toBeNull();
    expect(releaseCore(undefined)).toBeNull();
    expect(releaseCore('')).toBeNull();
    expect(releaseCore('unknown')).toBeNull();
    expect(releaseCore('0.7')).toBeNull();
  });
});

describe('versionMismatchSentence', () => {
  it('says nothing when both sides are the same release', () => {
    expect(versionMismatchSentence('0.7.0', '0.7.0')).toBeNull();
    expect(versionMismatchSentence('v0.7.0', '0.7.0-dev-abc1234')).toBeNull();
  });

  it('names both numbers when they differ', () => {
    expect(versionMismatchSentence('0.7.0', '0.6.0')).toBe(
      'This app is v0.7.0; the backend is v0.6.0 — update whichever is behind.',
    );
  });

  it('says nothing when either side is unknown', () => {
    expect(versionMismatchSentence(null, '0.7.0')).toBeNull();
    expect(versionMismatchSentence('0.7.0', null)).toBeNull();
    expect(versionMismatchSentence('0.7.0', 'unknown')).toBeNull();
  });
});
