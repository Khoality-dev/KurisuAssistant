import { describe, expect, it } from 'vitest';
import type { ParsedCharacterConfig, VrmSettings } from '@kurisu/models';
import { createVrmDriver } from './VrmDriver';
import { driverConformanceCases, IDLE_INPUT } from '../testing/conformance';
import { fakeClipLoader, fakeModelLoader, fakeRendererFactory } from '../testing/fakes';
import { clearModelCache } from './loader';

const MODEL = { url: '/character-assets/1/vrm/model', sha256: 'a'.repeat(64), bytes: 10, uploaded_at: '2026-09-20T00:00:00Z' };
const WAVE_CLIP = { id: 'c1ip0001', name: 'wave', url: '/character-assets/1/vrma/c1ip0001', sha256: 'b'.repeat(64), bytes: 10, loop: false };
const LOOK_CLIP = { id: 'c1ip0002', name: 'look', url: '/character-assets/1/vrma/c1ip0002', sha256: 'c'.repeat(64), bytes: 10, loop: false };

function settings(overrides: Partial<VrmSettings> = {}): VrmSettings {
  return {
    model: MODEL,
    clips: [],
    idle: {
      procedural: true, arms_lowered: true, breath_period_ms: 4000, breath_amplitude_deg: 2, sway_amplitude_deg: 1.5, sway_period_ms: 7000,
      blink: { blink_min_interval: 2000, blink_max_interval: 6000, blink_close_duration: 100, blink_hold_duration: 50, blink_open_duration: 100 },
      look_at: 'camera', idle_clip_ids: [], idle_clip_interval_ms: [8000, 20000],
    },
    emotion: { enabled: true, default_expression: 'neutral', intensity: 1, attack_ms: 180, release_ms: 400, thinking: null },
    reactions: [],
    camera: { target: 'upper_body', fov: 24, offset_y: 0, background: '#ffffff' },
    ...overrides,
  };
}

const config = (vrm: VrmSettings): ParsedCharacterConfig => ({ kind: 'vrm', poseTree: null, vrm });
const bytes = async () => new ArrayBuffer(8);

function canvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

function harness(vrm: VrmSettings, clips: Parameters<typeof fakeClipLoader>[0] = {}) {
  const renderers = fakeRendererFactory();
  const models = fakeModelLoader();
  const clipLoader = fakeClipLoader(clips);
  let clock = 0;
  const driver = createVrmDriver(canvas(), {
    rendererFactory: renderers.factory,
    modelLoader: models.loader,
    clipLoader: clipLoader.loader,
    now: () => clock,
    random: () => 0.5,
    seed: 11,
  });
  const deps = () => ({ resolveAsset: bytes, signal: new AbortController().signal });
  const tick = (input: Partial<Parameters<typeof driver.update>[1]> = {}, dt = 16) => {
    clock += dt;
    driver.update(dt, { ...IDLE_INPUT, ...input });
  };
  return { driver, renderers, models, clipLoader, deps, tick, config: config(vrm) };
}

describe('the VRM driver', () => {
  it('runs the conformance cases', async () => {
    await clearModelCache();
    const renderers = fakeRendererFactory();
    const models = fakeModelLoader();
    const cases = driverConformanceCases({
      makeDriver: () => createVrmDriver(canvas(), { rendererFactory: renderers.factory, modelLoader: models.loader, seed: 1 }),
      goodConfig: config(settings()),
      badConfig: config(settings({ model: null })),
      resolveAsset: bytes,
    });
    for (const c of cases) {
      await c.run();
    }
    expect(cases.length).toBeGreaterThan(5);
  });

  it('moves the mouth with the amplitude and closes it when playback stops', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    for (let i = 0; i < 30; i++) h.tick({ amplitude: 0.9, isPlaying: true });
    expect(h.driver.snapshot().mouth.aa).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) h.tick({ amplitude: 0.9, isPlaying: false });
    expect(h.driver.snapshot().mouth.aa).toBe(0);
    expect(h.renderers.renderers[0].renders).toBe(90);
  });

  it('fires a gesture reaction once for a one-tick gesture and respects its cooldown', async () => {
    await clearModelCache();
    const vrm = settings({
      reactions: [{ id: 'r1', name: 'wave back', when: [{ type: 'gesture', value: 'wave' }], play: { type: 'expression', expression: 'happy', weight: 1, hold_ms: 800 }, cooldown_ms: 4000 }],
    });
    const h = harness(vrm);
    await h.driver.load(h.config, h.deps());
    h.tick({ gestures: ['wave'] });
    expect(h.driver.snapshot().lastReactionId).toBe('r1');
    for (let i = 0; i < 20; i++) h.tick();
    expect(h.driver.snapshot().expressions.happy).toBeGreaterThan(0.9);
    // The same gesture again within the cooldown does nothing new; after the
    // hold and release the face is back to rest.
    for (let i = 0; i < 100; i++) h.tick({ gestures: i === 10 ? ['wave'] : [] });
    expect(h.driver.snapshot().expressions.happy).toBe(0);
  });

  it('plays a reaction clip once and hands the arms back to the procedural idle', async () => {
    await clearModelCache();
    const vrm = settings({
      clips: [WAVE_CLIP],
      reactions: [{ id: 'r2', name: 'wave', when: [{ type: 'gesture', value: 'wave' }], play: { type: 'clip', clip_id: WAVE_CLIP.id }, cooldown_ms: 0 }],
    });
    const h = harness(vrm, { [WAVE_CLIP.url]: { bones: ['leftUpperArm'], durationS: 0.5 } });
    await h.driver.load(h.config, h.deps());
    expect(h.clipLoader.calls).toEqual([WAVE_CLIP.url]);
    h.tick({ gestures: ['wave'] });
    expect(h.driver.snapshot().oneShotPlaying).toBe(true);
    for (let i = 0; i < 60; i++) h.tick();
    expect(h.driver.snapshot().oneShotPlaying).toBe(false);
  });

  it('turns look-at autoUpdate off while a clip with a look-at track plays, and back on after', async () => {
    await clearModelCache();
    const vrm = settings({
      clips: [LOOK_CLIP],
      reactions: [{ id: 'r3', name: 'look', when: [{ type: 'gesture', value: 'peace_sign' }], play: { type: 'clip', clip_id: LOOK_CLIP.id }, cooldown_ms: 0 }],
    });
    const h = harness(vrm, { [LOOK_CLIP.url]: { lookAt: true, durationS: 0.3 } });
    await h.driver.load(h.config, h.deps());
    h.tick();
    expect(h.driver.snapshot().lookAtAutoUpdate).toBe(true);
    h.tick({ gestures: ['peace_sign'] });
    expect(h.driver.snapshot().lookAtAutoUpdate).toBe(false);
    for (let i = 0; i < 40; i++) h.tick();
    expect(h.driver.snapshot().lookAtAutoUpdate).toBe(true);
  });

  it('shows a cue and fades it out', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    h.tick({ cue: { emotion: 'sad', hold_ms: 300 } });
    for (let i = 0; i < 15; i++) h.tick();
    expect(h.driver.snapshot().expressions.sad).toBeGreaterThan(0.9);
    for (let i = 0; i < 60; i++) h.tick();
    expect(h.driver.snapshot().expressions.sad).toBe(0);
  });

  it('exposes the model info once loaded and disposes idempotently under a double mount', async () => {
    await clearModelCache();
    const h = harness(settings());
    expect(h.driver.model).toBeNull();
    await h.driver.load(h.config, h.deps());
    expect(h.driver.model?.meta.name).toBe('Fake');
    expect(h.driver.model?.expressions.available.happy).toBe(true);
    h.driver.dispose();
    h.driver.dispose();
    expect(h.renderers.renderers[0].disposed).toBe(1);
    h.tick();
    expect(h.renderers.renderers[0].renders).toBe(0);
  });

  it('parses the model once for the same url and sha', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    await h.driver.load(h.config, h.deps());
    expect(h.models.calls).toHaveLength(1);
  });

  it('refuses a persona that is not 3D or has no model, with a sentence', async () => {
    await clearModelCache();
    const h = harness(settings());
    await expect(h.driver.load({ kind: 'pose_graph', poseTree: null, vrm: null }, h.deps())).rejects.toThrow(/3D character/);
    await expect(h.driver.load(config(settings({ model: null })), h.deps())).rejects.toThrow(/no 3D model yet/);
  });
});
