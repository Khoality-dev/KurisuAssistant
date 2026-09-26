/**
 * The words around exporting a persona with its character, and importing one (#248).
 */
import { describe, expect, it } from 'vitest';
import { CharacterUploadError } from '@kurisu/api';
import { exportedFilename, importFailure, includeLine, isBundle, meteredLine } from './personaExport';

describe('what the export dialog says it will include', () => {
  it('names the system, the files and their size', () => {
    expect(includeLine({ kind: 'vrm', files: 3, bytes: 42_100_000, vrm_bytes: 42_000_000 }))
      .toBe('Its 3D character · 3 files · 42.1 MB');
    expect(includeLine({ kind: 'pose_graph', files: 1, bytes: 120_000, vrm_bytes: 0 }))
      .toBe('Its 2D character · 1 file · 0.1 MB');
  });

  it('says so when there is nothing to include', () => {
    expect(includeLine(null)).toBe('This persona has no character to include.');
  });

  it('says what an import will count against, only when something is metered', () => {
    expect(meteredLine({ kind: 'vrm', files: 2, bytes: 5_000_000, vrm_bytes: 4_000_000 }))
      .toBe('Importing it uses 4.0 MB of the 3D character storage of the account it goes into.');
    expect(meteredLine({ kind: 'pose_graph', files: 4, bytes: 5_000_000, vrm_bytes: 0 })).toBeNull();
    expect(meteredLine(null)).toBeNull();
  });
});

describe('the exported file', () => {
  it('is a .zip with the character and a .json without', () => {
    expect(exportedFilename('Makise Kurisu', true)).toBe('Makise_Kurisu.zip');
    expect(exportedFilename('Makise Kurisu', false)).toBe('Makise_Kurisu.json');
  });
});

describe('which import a file goes to', () => {
  it('sends a zip to the bundle import and anything else to the JSON one', () => {
    expect(isBundle(new File(['PK'], 'kurisu.zip'))).toBe(true);
    expect(isBundle(new File(['PK'], 'KURISU.ZIP'))).toBe(true);
    expect(isBundle(new File(['PK'], 'bundle', { type: 'application/zip' }))).toBe(true);
    expect(isBundle(new File(['{}'], 'kurisu.json'))).toBe(false);
  });
});

describe('what a refused import says', () => {
  it('turns a full store into the figures and what to do', () => {
    const error = new CharacterUploadError('quota', 'Full.', { status: 507, usedBytes: 900_000_000, quotaBytes: 1_000_000_000 });
    expect(importFailure(error)).toBe(
      "That persona's 3D character does not fit: 900.0 MB of 1000.0 MB is used. Remove a model or an animation first, or export it without its character.",
    );
  });

  it("keeps the server's own sentence for anything else", () => {
    expect(importFailure(new CharacterUploadError('not_vrm', 'That file is not a VRM.', { status: 415 })))
      .toBe('That file is not a VRM.');
    expect(importFailure(new CharacterUploadError('unknown', 'The bundle lists a file the store never writes.', { status: 400 })))
      .toBe('The bundle lists a file the store never writes.');
  });

  it('describes anything that is not a refusal', () => {
    expect(importFailure(new Error('boom'))).toBe('boom');
  });
});
