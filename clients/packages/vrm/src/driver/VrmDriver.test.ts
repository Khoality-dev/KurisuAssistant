import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ParsedCharacterConfig, VrmSettings } from '@kurisu/models';
import { ARM_DROP_RAD, createVrmDriver, type VrmDriver } from './VrmDriver';
import { driverConformanceCases, IDLE_INPUT } from '../testing/conformance';
import { fakeClipLoader, fakeModelLoader, fakeRendererFactory, type FakeVrm, type FakeVrmOptions } from '../testing/fakes';
import { cachedInstanceCount, clearModelCache, modelCacheKey } from './loader';

const MODEL = { url: '/character-assets/1/vrm/model', sha256: 'a'.repeat(64), bytes: 10, uploaded_at: '2026-09-20T00:00:00Z' };
const WAVE_CLIP = { id: 'c1ip0001', name: 'wave', url: '/character-assets/1/vrma/c1ip0001', sha256: 'b'.repeat(64), bytes: 10, loop: false };
const LOOK_CLIP = { id: 'c1ip0002', name: 'look', url: '/character-assets/1/vrma/c1ip0002', sha256: 'c'.repeat(64), bytes: 10, loop: false };
const KEY = modelCacheKey(MODEL.url, MODEL.sha256);

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

function harness(vrm: VrmSettings, clips: Parameters<typeof fakeClipLoader>[0] = {}, fake: FakeVrmOptions = {}, extra: Parameters<typeof createVrmDriver>[1] = {}) {
  const renderers = fakeRendererFactory();
  const models = fakeModelLoader(fake);
  const clipLoader = fakeClipLoader(clips);
  let clock = 0;
  const driver = createVrmDriver(canvas(), {
    rendererFactory: renderers.factory,
    modelLoader: models.loader,
    clipLoader: clipLoader.loader,
    now: () => clock,
    random: () => 0.5,
    seed: 11,
    ...extra,
  });
  const deps = () => ({ resolveAsset: bytes, signal: new AbortController().signal });
  const tick = (input: Partial<Parameters<typeof driver.update>[1]> = {}, dt = 16) => {
    clock += Number.isFinite(dt) ? dt : 0;
    driver.update(dt, { ...IDLE_INPUT, ...input });
  };
  const fakeVrmOf = (): FakeVrm => models.vrms[models.vrms.length - 1];
  return { driver, renderers, models, clipLoader, deps, tick, vrm: fakeVrmOf, config: config(vrm) };
}

const worldY = (node: THREE.Object3D): number => {
  const p = new THREE.Vector3();
  node.updateWorldMatrix(true, false);
  node.getWorldPosition(p);
  return p.y;
};

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
      probe: (d) => {
        const snap = (d as VrmDriver).snapshot();
        return { loaded: snap.loaded, framesDrawn: snap.framesDrawn, mouthOpen: snap.mouth.aa };
      },
    });
    for (const c of cases) {
      await clearModelCache();
      await c.run();
    }
    expect(cases.length).toBeGreaterThan(8);
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

  it('lowers the arms on a VRM 1.0 and on a VRM 0.x rig alike', async () => {
    for (const metaVersion of ['1', '0'] as const) {
      await clearModelCache();
      const h = harness(settings(), {}, { metaVersion });
      await h.driver.load(h.config, h.deps());
      const upper = h.vrm().humanoid.getNormalizedBoneNode('leftUpperArm')!;
      const lower = h.vrm().humanoid.getNormalizedBoneNode('leftLowerArm')!;
      const hand = h.vrm().humanoid.getNormalizedBoneNode('leftHand')!;
      expect(h.driver.model?.meta.metaVersion).toBe(metaVersion);
      expect(worldY(lower), `metaVersion ${metaVersion}: the forearm should hang below the shoulder`).toBeLessThan(worldY(upper) - 0.15);
      expect(worldY(hand)).toBeLessThan(worldY(lower));
      const rightLower = h.vrm().humanoid.getNormalizedBoneNode('rightLowerArm')!;
      const rightUpper = h.vrm().humanoid.getNormalizedBoneNode('rightUpperArm')!;
      expect(worldY(rightLower)).toBeLessThan(worldY(rightUpper) - 0.15);
      // The written Euler is conjugated for 0.x, not the same number.
      expect(upper.rotation.z).toBeCloseTo(metaVersion === '0' ? ARM_DROP_RAD : -ARM_DROP_RAD, 5);
      h.driver.dispose();
    }
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
    expect(h.driver.snapshot().reactionsFired).toBe(1);
    for (let i = 0; i < 20; i++) h.tick();
    expect(h.driver.snapshot().expressions.happy).toBeGreaterThan(0.9);
    // The same gesture again within the cooldown does nothing: the face has
    // released by 1300 ms (800 hold + 400 release), which it could not have
    // if the second wave at ~500 ms had re-fired.
    for (let i = 0; i < 100; i++) {
      h.tick({ gestures: i === 10 ? ['wave'] : [] });
      if (i === 65) expect(h.driver.snapshot().expressions.happy).toBe(0);
    }
    expect(h.driver.snapshot().reactionsFired).toBe(1);
    expect(h.driver.snapshot().expressions.happy).toBe(0);
    // After the cooldown the gesture fires again.
    for (let i = 0; i < 160; i++) h.tick();
    h.tick({ gestures: ['wave'] });
    expect(h.driver.snapshot().reactionsFired).toBe(2);
  });

  it('plays a reaction clip once, fades it out, and hands the arm back to the procedural idle', async () => {
    await clearModelCache();
    const vrm = settings({
      clips: [WAVE_CLIP],
      reactions: [{ id: 'r2', name: 'wave', when: [{ type: 'gesture', value: 'wave' }], play: { type: 'clip', clip_id: WAVE_CLIP.id }, cooldown_ms: 0 }],
    });
    const h = harness(vrm, { [WAVE_CLIP.url]: { bones: ['leftUpperArm'], durationS: 0.5 } });
    await h.driver.load(h.config, h.deps());
    expect(h.clipLoader.calls).toEqual([WAVE_CLIP.url]);
    const upper = h.vrm().humanoid.getNormalizedBoneNode('leftUpperArm')!;
    h.tick();
    expect(upper.rotation.z).toBeCloseTo(-ARM_DROP_RAD, 5);

    h.tick({ gestures: ['wave'] });
    expect(h.driver.snapshot().oneShotPlaying).toBe(true);
    expect(h.driver.snapshot().ownedNodes).toContain(upper.name);
    for (let i = 0; i < 10; i++) h.tick();
    // While the clip owns the arm, the procedural drop is not written.
    expect(upper.rotation.z).not.toBeCloseTo(-ARM_DROP_RAD, 2);
    expect(h.driver.snapshot().ownedNodes).toContain(upper.name);

    // 0.5 s clip + 0.25 s fade: still owned through the fade, then handed back.
    for (let i = 0; i < 25; i++) h.tick();
    expect(h.driver.snapshot().oneShotPlaying).toBe(true);
    for (let i = 0; i < 30; i++) h.tick();
    expect(h.driver.snapshot().oneShotPlaying).toBe(false);
    expect(h.driver.snapshot().ownedNodes).not.toContain(upper.name);
    expect(upper.rotation.z).toBeCloseTo(-ARM_DROP_RAD, 5);
  });

  it('does not restart a clip reaction that is already playing', async () => {
    await clearModelCache();
    const vrm = settings({
      clips: [WAVE_CLIP],
      reactions: [{ id: 'r2', name: 'wave', when: [{ type: 'gesture', value: 'wave' }], play: { type: 'clip', clip_id: WAVE_CLIP.id }, cooldown_ms: 0 }],
    });
    const h = harness(vrm, { [WAVE_CLIP.url]: { bones: ['leftUpperArm'], durationS: 0.5 } });
    await h.driver.load(h.config, h.deps());
    h.tick({ gestures: ['wave'] });
    for (let i = 0; i < 5; i++) h.tick({ gestures: ['wave'] });
    // cooldown_ms 0 still means "not before the clip is over".
    expect(h.driver.snapshot().reactionsFired).toBe(1);
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
    for (let i = 0; i < 60; i++) h.tick();
    expect(h.driver.snapshot().lookAtAutoUpdate).toBe(true);
  });

  it('puts the eyes back to straight ahead once when look_at is off', async () => {
    await clearModelCache();
    const h = harness(settings({ idle: { ...settings().idle, look_at: 'off' } }));
    await h.driver.load(h.config, h.deps());
    const lookAt = h.vrm().lookAt as unknown as { resets: number; target: unknown };
    const after = lookAt.resets;
    h.tick();
    h.tick();
    h.tick();
    expect(lookAt.resets).toBe(after + 1);
    expect(lookAt.target).toBeNull();
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

  it('keeps lip sync alive under an expression that blocks the mouth, as the mesh would show it', async () => {
    await clearModelCache();
    const h = harness(settings(), {}, { overrideMouth: { happy: 'block' } });
    await h.driver.load(h.config, h.deps());
    h.tick({ cue: { emotion: 'happy', hold_ms: 9000 } });
    for (let i = 0; i < 30; i++) h.tick();
    expect(h.vrm().effective.happy).toBeGreaterThan(0.9);
    for (let i = 0; i < 60; i++) h.tick({ amplitude: 0.9, isPlaying: true });
    // The face went, ramped, and the mouth the mesh shows follows the voice.
    expect(h.vrm().effective.happy).toBe(0);
    expect(h.vrm().effective.aa).toBeGreaterThan(0.5);
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
    expect(h.renderers.renderers[0].contextLosses).toBe(0);
    h.tick();
    expect(h.renderers.renderers[0].renders).toBe(0);
  });

  it('forces the context lost on dispose only when asked to', async () => {
    await clearModelCache();
    const h = harness(settings(), {}, {}, { releaseContextOnDispose: true });
    await h.driver.load(h.config, h.deps());
    h.driver.dispose();
    expect(h.renderers.renderers[0].contextLosses).toBe(1);
  });

  it('parses the model once for the same url and sha, and resets it on every load', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    const hips = h.vrm().humanoid.getNormalizedBoneNode('hips')!;
    const restY = hips.position.y;
    for (let i = 0; i < 40; i++) h.tick();
    h.tick({ cue: { emotion: 'angry', hold_ms: 9000 } });
    for (let i = 0; i < 20; i++) h.tick();
    expect(h.vrm().weights.angry).toBeGreaterThan(0.5);
    await h.driver.load(h.config, h.deps());
    expect(h.models.calls).toHaveLength(1);
    expect(h.vrm().weights.angry).toBe(0);
    expect(hips.position.y).toBeCloseTo(restY, 6);
    h.tick();
    // The breathing bob is measured from the rest height, not from where the
    // last session left the hips.
    expect(Math.abs(hips.position.y - restY)).toBeLessThan(0.01);
  });

  it('gives two live drivers on the same model their own scene graphs', async () => {
    await clearModelCache();
    const a = harness(settings());
    const b = harness(settings());
    await a.driver.load(a.config, a.deps());
    await b.driver.load(b.config, b.deps());
    expect(a.models.calls).toHaveLength(1);
    expect(b.models.calls).toHaveLength(1);
    expect(cachedInstanceCount(KEY)).toBe(2);
    expect(a.vrm().scene.parent).not.toBeNull();
    expect(b.vrm().scene.parent).not.toBeNull();
    expect(a.vrm().scene.parent).not.toBe(b.vrm().scene.parent);
    a.driver.dispose();
    // A third driver takes the instance the first released, without a parse.
    const c = harness(settings());
    await c.driver.load(c.config, c.deps());
    expect(c.models.calls).toHaveLength(0);
    expect(cachedInstanceCount(KEY)).toBe(2);
  });

  it('refuses a persona that is not 3D or has no model, with a sentence, and holds nothing after', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    await expect(h.driver.load({ kind: 'pose_graph', poseTree: null, vrm: null }, h.deps())).rejects.toThrow(/3D character/);
    expect(h.driver.snapshot().loaded).toBe(false);
    await expect(h.driver.load(config(settings({ model: null })), h.deps())).rejects.toThrow(/no 3D model yet/);
    expect(h.driver.model).toBeNull();
  });

  it('survives a NaN frame without poisoning the next ones', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    h.tick({ amplitude: Number.NaN, isPlaying: true }, Number.NaN);
    for (let i = 0; i < 20; i++) h.tick({ amplitude: 0.8, isPlaying: true });
    const snap = h.driver.snapshot();
    expect(Number.isFinite(snap.mouth.aa) && snap.mouth.aa > 0.3).toBe(true);
    expect(Number.isFinite(snap.blinkWeight)).toBe(true);
    for (const w of Object.values(snap.expressions)) expect(Number.isFinite(w)).toBe(true);
    const chest = h.vrm().humanoid.getNormalizedBoneNode('chest')!;
    expect(Number.isFinite(chest.rotation.x)).toBe(true);
  });

  it('plays a built-in wave: the right arm rises, then goes back to the lowered pose', async () => {
    await clearModelCache();
    const h = harness(settings({
      reactions: [{ id: 'wave', name: 'wave back', when: [{ type: 'gesture', value: 'wave' }], play: { type: 'motion', motion: 'wave' }, cooldown_ms: 0 }],
    }));
    await h.driver.load(h.config, h.deps());
    const upper = h.vrm().humanoid.getNormalizedBoneNode('rightUpperArm')!;
    const hand = h.vrm().humanoid.getNormalizedBoneNode('rightHand')!;
    h.tick();
    expect(upper.rotation.z).toBeCloseTo(ARM_DROP_RAD, 5);
    h.tick({ gestures: ['wave'] });
    expect(h.driver.snapshot().motion).toBe('wave');
    for (let i = 0; i < 60; i++) h.tick(); // ~1 s in: full weight
    expect(worldY(hand)).toBeGreaterThan(worldY(upper));
    for (let i = 0; i < 100; i++) h.tick();
    expect(h.driver.snapshot().motion).toBeNull();
    expect(upper.rotation.z).toBeCloseTo(ARM_DROP_RAD, 5);
  });

  it('leaves a bone a clip is animating to the clip, even mid-move', async () => {
    await clearModelCache();
    const vrm = settings({
      clips: [WAVE_CLIP],
      reactions: [{ id: 'r2', name: 'clip', when: [{ type: 'gesture', value: 'wave' }], play: { type: 'clip', clip_id: WAVE_CLIP.id }, cooldown_ms: 0 }],
    });
    const h = harness(vrm, { [WAVE_CLIP.url]: { bones: ['head'], durationS: 3 } });
    await h.driver.load(h.config, h.deps());
    const head = h.vrm().humanoid.getNormalizedBoneNode('head')!;
    h.tick({ gestures: ['wave'] });
    h.driver.trigger({ type: 'motion', motion: 'look_around' });
    // ~2.24 s in, the look around turns the head the other way (y < 0), while
    // the fake clip is still turning it toward +45° about y.
    for (let i = 0; i < 140; i++) h.tick();
    expect(h.driver.snapshot().ownedNodes).toContain(head.name);
    expect(h.driver.snapshot().motion).toBe('look_around');
    expect(head.rotation.y).toBeGreaterThan(0);
  });

  it('puts built-in moves in the idle rotation, never while she speaks', async () => {
    await clearModelCache();
    const vrm = settings();
    vrm.idle = { ...vrm.idle, idle_motions: ['nod'], idle_clip_interval_ms: [100, 100] };
    const h = harness(vrm);
    await h.driver.load(h.config, h.deps());
    for (let i = 0; i < 20; i++) h.tick({ isPlaying: true, amplitude: 0.5 });
    expect(h.driver.snapshot().motion).toBeNull();
    // The quiet wait only runs once she has stopped: 100 ms of it, then the nod.
    for (let i = 0; i < 5; i++) h.tick();
    expect(h.driver.snapshot().motion).toBeNull();
    for (let i = 0; i < 3; i++) h.tick();
    expect(h.driver.snapshot().motion).toBe('nod');
  });

  it('has no built-in moves in a config stored before the field existed', async () => {
    await clearModelCache();
    const vrm = settings();
    vrm.idle = { ...vrm.idle, idle_clip_interval_ms: [0, 0] };
    const h = harness(vrm);
    await h.driver.load(h.config, h.deps());
    for (let i = 0; i < 50; i++) h.tick();
    expect(h.driver.snapshot().motion).toBeNull();
  });

  it('plays what a Try button asks for, and takes new settings without a reload', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    h.driver.trigger({ type: 'expression', expression: 'happy', weight: 1, hold_ms: 1000 });
    for (let i = 0; i < 20; i++) h.tick();
    expect(h.driver.snapshot().expressions.happy).toBeGreaterThan(0.9);
    h.driver.trigger({ type: 'motion', motion: 'bow' });
    h.tick();
    expect(h.driver.snapshot().motion).toBe('bow');

    const loads = h.models.calls.length;
    const next = settings();
    next.reactions = [{ id: 'nod', name: '', when: [{ type: 'gesture', value: 'thumbs_up' }], play: { type: 'motion', motion: 'nod' }, cooldown_ms: 0 }];
    for (let i = 0; i < 200; i++) h.tick();
    h.driver.configure(next);
    h.tick({ gestures: ['thumbs_up'] });
    expect(h.driver.snapshot().lastReactionId).toBe('nod');
    expect(h.models.calls.length).toBe(loads);
  });

  it('hands a replaced move over without snapping the pose', async () => {
    await clearModelCache();
    const h = harness(settings());
    await h.driver.load(h.config, h.deps());
    const upper = h.vrm().humanoid.getNormalizedBoneNode('rightUpperArm')!;
    h.driver.trigger({ type: 'motion', motion: 'wave' });
    for (let i = 0; i < 60; i++) h.tick(); // the arm is up
    const raised = upper.rotation.z;
    expect(raised).toBeLessThan(0);
    h.driver.trigger({ type: 'motion', motion: 'nod' }); // uses no arm
    let prev = raised;
    for (let i = 0; i < 30; i++) {
      h.tick();
      expect(Math.abs(upper.rotation.z - prev), `frame ${i}`).toBeLessThan(0.35);
      prev = upper.rotation.z;
    }
    expect(h.driver.snapshot().motion).toBe('nod');
    expect(upper.rotation.z).toBeCloseTo(ARM_DROP_RAD, 5); // handed back to the lowered pose
  });

  it('plays each idle pick once, a move or a clip, never two at a time', async () => {
    await clearModelCache();
    const vrm = settings({ clips: [WAVE_CLIP] });
    vrm.idle = { ...vrm.idle, idle_motions: ['nod'], idle_clip_ids: [WAVE_CLIP.id], idle_clip_interval_ms: [100, 100] };
    let n = 0;
    const h = harness(vrm, { [WAVE_CLIP.url]: { bones: ['leftUpperArm'], durationS: 0.5 } }, {}, { random: () => (n++ % 2 ? 0.9 : 0.1) });
    await h.driver.load(h.config, h.deps());
    let moves = 0;
    let clips = 0;
    let wasMove = false;
    let wasClip = false;
    for (let i = 0; i < 1000; i++) {
      h.tick();
      const snap = h.driver.snapshot();
      const isMove = snap.motion !== null;
      const isClip = snap.oneShotPlaying;
      expect(isMove && isClip, `tick ${i}`).toBe(false);
      if (isMove && !wasMove) moves++;
      if (isClip && !wasClip) clips++;
      wasMove = isMove;
      wasClip = isClip;
    }
    // ~16 s: a nod is 1.2 s and the clip 0.75 s with its fade, each followed by 0.1 s of quiet.
    expect(moves).toBeGreaterThan(2);
    expect(clips).toBeGreaterThan(2);
    // A clip pick is one play: its bone goes back to the procedural idle between picks.
    expect(h.driver.snapshot().ownedNodes.length === 0 || h.driver.snapshot().oneShotPlaying).toBe(true);
  });
});
