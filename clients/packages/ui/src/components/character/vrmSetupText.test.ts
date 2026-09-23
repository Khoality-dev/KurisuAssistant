import { describe, expect, it } from 'vitest';
import { applyMovePreset, defaultVrmSettings, setRecipe, type VrmAssetRef } from '@kurisu/models';
import { asUploadCode, isCancelled, mb, modelStatus, stepSummaries, uploadErrorText } from './vrmSetupText';

const model = (over: Partial<VrmAssetRef> = {}): VrmAssetRef => ({
  url: '/character-assets/1/vrm/model',
  sha256: 'a'.repeat(64),
  bytes: 18_400_000,
  uploaded_at: '2026-09-21T10:00:00Z',
  filename: 'kurisu_v2.vrm',
  spec_version: '1.0',
  expressions: ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'],
  ...over,
});

describe('upload failure wording', () => {
  it('names the file and says what to do, for the two checks the mockup shows', () => {
    expect(uploadErrorText('not_vrm', 'kurisu_blender.glb')).toEqual([
      'That file isn’t a VRM model',
      'kurisu_blender.glb is a plain 3D file. In VRoid Studio, use Export → Export as VRM and upload that file instead.',
    ]);
    expect(uploadErrorText('no_humanoid', 'kurisu_rigless.vrm')[0]).toBe('This model can’t move');
  });

  it('gives the limit when a file is too big', () => {
    expect(uploadErrorText('too_large', 'big.vrm', { maxBytes: 100 * 1024 * 1024, size: 120_000_000 })[1]).toContain('104.9 MB');
  });

  it('reads an unknown code as unknown', () => {
    expect(asUploadCode('teapot')).toBe('unknown');
    expect(asUploadCode('quota')).toBe('quota');
    expect(isCancelled(asUploadCode('cancelled'))).toBe(true);
    expect(isCancelled(asUploadCode('network'))).toBe(false);
    expect(uploadErrorText('unknown', 'x')[0]).toBe('The upload failed');
  });

  it('writes megabytes with one decimal', () => {
    expect(mb(18_400_000)).toBe('18.4 MB');
  });
});

describe('model status', () => {
  it('is ready when every face is there', () => {
    expect(modelStatus(model())).toEqual({ ok: true, text: 'Ready. She can talk, blink, move and show every feeling.' });
  });

  it('names the missing face of an older file', () => {
    const status = modelStatus(model({ spec_version: '0.x', expressions: ['neutral', 'happy', 'angry', 'sad', 'relaxed'] }));
    expect(status.ok).toBe(false);
    expect(status.text).toBe('Works, but this older file has no “surprised” face. She’ll look neutral instead. Export again from a newer VRoid Studio to fix it.');
  });
});

describe('step summaries', () => {
  it('summarises the defaults', () => {
    const s = defaultVrmSettings();
    expect(stepSummaries(s)).toEqual({
      model: 'No model yet',
      move: 'Natural · stretches now and then',
      feel: 'On · usual face Neutral · Strong',
      react: '3 of 5 on',
      frame: 'Waist up · White background',
      fine: 'Not needed for most people',
    });
  });

  it('follows the choices', () => {
    const s = defaultVrmSettings();
    const edited = {
      ...s,
      model: model({ expressions: ['neutral', 'happy'] }),
      idle: { ...applyMovePreset(s.idle, 'lively'), sway_amplitude_deg: 4 },
      emotion: { ...s.emotion, enabled: false, default_expression: 'relaxed' as const },
      reactions: setRecipe(s.reactions, 'peace', true),
      camera: { ...s.camera, target: 'head' as const, background: '#1E2230' },
    };
    const sum = stepSummaries(edited);
    expect(sum.model).toBe('kurisu_v2.vrm · 4 faces missing');
    expect(sum.move).toBe('Custom (set in Fine-tune)');
    expect(sum.feel).toBe('Off · always Relaxed');
    expect(sum.react).toBe('4 of 5 on');
    expect(sum.frame).toBe('Face · Dark background');
  });
});
