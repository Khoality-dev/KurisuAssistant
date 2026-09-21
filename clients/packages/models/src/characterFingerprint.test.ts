import { describe, expect, it } from 'vitest';
import type { ParsedCharacterConfig, PoseTree, VrmSettings } from './character';
import { characterFingerprint } from './characterFingerprint';

const node = (id: string, base: string) => ({
  id,
  name: id,
  type: 'pose' as const,
  position: { x: 0, y: 0 },
  pose_config: {
    name: id,
    base_image_url: base,
    left_eye: { patches: [] },
    right_eye: { patches: [] },
    mouth: { patches: [] },
  },
});

const tree = (base = '/character-assets/1/a/base'): PoseTree => ({
  default_pose_ids: ['a'],
  nodes: [node('a', base)],
  edges: [],
});

const vrm = (over: Partial<VrmSettings> = {}): VrmSettings => ({
  model: { url: '/character-assets/1/vrm/model', sha256: 'aa'.repeat(32), bytes: 10, uploaded_at: 't' },
  clips: [],
  idle: {
    procedural: true, arms_lowered: true, breath_period_ms: 4000, breath_amplitude_deg: 2,
    sway_amplitude_deg: 1.5, sway_period_ms: 7000,
    blink: { blink_min_interval: 2000, blink_max_interval: 6000, blink_close_duration: 100, blink_hold_duration: 50, blink_open_duration: 100 },
    look_at: 'camera', idle_clip_ids: [], idle_clip_interval_ms: [8000, 20000],
  },
  emotion: { enabled: true, default_expression: 'neutral', intensity: 1, attack_ms: 180, release_ms: 400 },
  reactions: [],
  camera: { target: 'upper_body', fov: 24, offset_y: 0, background: '#ffffff' },
  ...over,
});

const pg = (t: PoseTree | null): ParsedCharacterConfig => ({ kind: 'pose_graph', poseTree: t, vrm: null });
const v = (s: VrmSettings | null): ParsedCharacterConfig => ({ kind: 'vrm', poseTree: null, vrm: s });

describe('characterFingerprint', () => {
  it('is stable for equal content, whatever the object identity', () => {
    expect(characterFingerprint(pg(tree()))).toBe(characterFingerprint(pg(tree())));
    expect(characterFingerprint(v(vrm()))).toBe(characterFingerprint(v(vrm())));
    expect(characterFingerprint(null)).toBe('none');
  });

  it('changes when a pose image changes with the counts unchanged — what the old count comparison missed', () => {
    expect(characterFingerprint(pg(tree('/character-assets/1/a/base'))))
      .not.toBe(characterFingerprint(pg(tree('/character-assets/1/b/base'))));
  });

  it('changes when the VRM model is re-uploaded, or a setting moves', () => {
    const a = characterFingerprint(v(vrm()));
    const reuploaded = vrm({ model: { url: '/character-assets/1/vrm/model', sha256: 'bb'.repeat(32), bytes: 10, uploaded_at: 't' } });
    expect(characterFingerprint(v(reuploaded))).not.toBe(a);
    const wider = vrm({ camera: { target: 'full_body', fov: 24, offset_y: 0, background: '#ffffff' } });
    expect(characterFingerprint(v(wider))).not.toBe(a);
  });

  it('tells the kinds apart, and an empty member from a full one', () => {
    expect(characterFingerprint(pg(null))).toBe('pose_graph:empty');
    expect(characterFingerprint(v(null))).toBe('vrm:empty');
    expect(characterFingerprint(pg(tree()))).not.toBe(characterFingerprint(v(vrm())));
  });
});
