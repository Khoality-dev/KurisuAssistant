/**
 * At most one WebGL stage per window (#240).
 *
 * Three VRM personas in one conversation must make one driver, not three —
 * Chromium's context cap and software GL are the reason — and the other two
 * are cards. Which one is live follows the conversation: the active persona,
 * else the last VRM persona to speak, else the first. 2D personas are not
 * counted and keep drawing beside it.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterDriver, ParsedCharacterConfig, PoseTree, VrmAssetRef, VrmSettings } from '@kurisu/models';
import type { CharacterPersona } from '@kurisu/state';

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  fetchAuthedBytes: vi.fn(async () => new ArrayBuffer(0)),
}));

import { CharacterStack, liveStagePersona } from './CharacterStack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const model = (n: number) => ({
  url: `/character-assets/${n}/vrm/model`,
  sha256: String(n).repeat(64).slice(0, 64),
  bytes: 1000,
  uploaded_at: '2026-09-21T00:00:00Z',
}) as VrmAssetRef;

const vrm = (n: number, withModel = true): ParsedCharacterConfig => ({
  kind: 'vrm',
  poseTree: null,
  vrm: {
    model: withModel ? model(n) : null,
    clips: [],
    reactions: [],
    idle: {} as VrmSettings['idle'],
    emotion: {} as VrmSettings['emotion'],
    camera: { target: 'upper_body', fov: 24, offset_y: 0, background: '#ffffff' },
  },
});

const tree: PoseTree = {
  default_pose_ids: ['a'],
  nodes: [{
    id: 'a', name: 'a', type: 'pose', position: { x: 0, y: 0 },
    pose_config: { name: 'a', base_image_url: '/character-assets/9/a/base', left_eye: { patches: [] }, right_eye: { patches: [] }, mouth: { patches: [] } },
  }],
  edges: [],
};
const poseGraph: ParsedCharacterConfig = { kind: 'pose_graph', poseTree: tree, vrm: null };

const persona = (name: string, character: ParsedCharacterConfig): CharacterPersona => ({ name, avatarUuid: null, character });

let container: HTMLDivElement;
let root: Root;
let made: Array<{ kind: string; persona: string; disposed: number }>;

function makeDriver(character: ParsedCharacterConfig): CharacterDriver {
  const record = { kind: character.kind, persona: character.vrm?.model?.url ?? 'pose', disposed: 0 };
  const d: CharacterDriver = {
    kind: character.kind,
    async load() {},
    update() {},
    resize() {},
    dispose() { record.disposed++; },
  };
  made.push(record);
  return d;
}
/** VRM drivers made and not yet disposed: what holds a WebGL context right now. */
const liveVrm = () => made.filter((m) => m.kind === 'vrm' && m.disposed === 0);

function render(personas: Map<number, CharacterPersona>, activePersonaId: number | null) {
  act(() => {
    root.render(
      <CharacterStack personas={personas} activePersonaId={activePersonaId} makeDriver={makeDriver} probe={() => true} now={() => 0} />,
    );
  });
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
const cards = () => container.querySelectorAll('[data-testid="character-waiting-card"]');
const slotHasStage = (id: number) => !!container.querySelector(`[data-testid="character-slot-${id}"] [data-testid="character-surface"]`);

describe('CharacterStack', () => {
  beforeEach(() => {
    made = [];
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('three VRM personas: one driver, two cards, the stage with the one speaking', async () => {
    const personas = new Map([[1, persona('A', vrm(1))], [2, persona('B', vrm(2))], [3, persona('C', vrm(3))]]);
    render(personas, 2);
    await settle();
    expect(made).toEqual([{ kind: 'vrm', persona: '/character-assets/2/vrm/model', disposed: 0 }]);
    expect(cards()).toHaveLength(2);
    expect(slotHasStage(2)).toBe(true);
    expect(container.textContent).toContain('waiting');
  });

  it('when the stage moves to another persona, the old driver is disposed: exactly one live', async () => {
    const personas = new Map([[1, persona('A', vrm(1))], [2, persona('B', vrm(2))], [3, persona('C', vrm(3))]]);
    render(personas, 1);
    await settle();
    render(personas, 3);
    await settle();
    expect(made.filter((m) => m.kind === 'vrm')).toHaveLength(2);
    expect(liveVrm()).toEqual([{ kind: 'vrm', persona: '/character-assets/3/vrm/model', disposed: 0 }]);
    expect(made.find((m) => m.persona.includes('/1/'))!.disposed).toBe(1);
    expect(slotHasStage(1)).toBe(false);
    expect(slotHasStage(3)).toBe(true);
    expect(cards()).toHaveLength(2);
  });

  it('a 2D persona keeps drawing beside the live stage, and does not take it', async () => {
    const personas = new Map([[1, persona('A', vrm(1))], [2, persona('Mayuri', poseGraph)], [3, persona('C', vrm(3))]]);
    render(personas, 3);
    await settle();
    render(personas, 2); // the 2D persona speaks
    await settle();
    // The VRM persona that spoke last keeps its stage; the pose graph draws too.
    expect(slotHasStage(3)).toBe(true);
    expect(slotHasStage(2)).toBe(true);
    expect(cards()).toHaveLength(1);
    expect(made.filter((m) => m.kind === 'vrm')).toHaveLength(1);
    expect(liveVrm()).toHaveLength(1);
  });

  it('a VRM persona with no model yet needs no stage and is not a card', async () => {
    const personas = new Map([[1, persona('A', vrm(1, false))], [2, persona('B', vrm(2))]]);
    render(personas, null);
    await settle();
    expect(cards()).toHaveLength(0);
    expect(container.textContent).toContain('No 3D model yet');
  });
});

describe('liveStagePersona', () => {
  const personas = new Map([[1, persona('A', vrm(1))], [2, persona('M', poseGraph)], [3, persona('C', vrm(3))]]);

  it('is the active persona when it has a stage to show', () => {
    expect(liveStagePersona(personas, 3, 1)).toBe(3);
  });
  it('falls back to the last VRM persona to speak, then to the first', () => {
    expect(liveStagePersona(personas, 2, 3)).toBe(3);
    expect(liveStagePersona(personas, null, null)).toBe(1);
  });
  it('is null when nobody needs a stage', () => {
    expect(liveStagePersona(new Map([[2, persona('M', poseGraph)]]), 2, null)).toBeNull();
  });
});
