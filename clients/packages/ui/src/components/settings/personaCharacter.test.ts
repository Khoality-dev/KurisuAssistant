import { describe, expect, it } from 'vitest';
import { defaultVrmSettings, type CharacterConfigDTO } from '@kurisu/models';
import { characterLabel, deletedFiles } from './PersonasSection';

const model = {
  url: '/character-assets/1/vrm/model', sha256: 'a'.repeat(64), bytes: 18_400_000, uploaded_at: '2026-09-21T00:00:00Z',
  filename: 'kurisu_v2.vrm', spec_version: '1.0' as const, expressions: [],
};
const clip = { id: 'c1ip0001', name: 'hop', url: '/character-assets/1/vrma/c1ip0001', sha256: 'b'.repeat(64), bytes: 250_000, loop: false };
const tree = {
  default_pose_ids: ['p1'],
  nodes: [
    { id: 'p1', name: 'idle', type: 'pose' as const, position: { x: 0, y: 0 }, pose_config: {
      name: 'idle', base_image_url: '/character-assets/1/p1/base',
      left_eye: { patches: [{ image_url: 'a', x: 0, y: 0, width: 1, height: 1 }] }, right_eye: { patches: [] }, mouth: { patches: [] },
    } },
    { id: 'p2', name: 'smile', type: 'pose' as const, position: { x: 0, y: 0 } },
  ],
  edges: [{ id: 'e1', from_node_id: 'p1', to_node_id: 'p2', transitions: [{ conditions: [], video_urls: ['/character-assets/1/edges/e1'] }] }],
};

describe('the persona card’s character line', () => {
  it('says which system shows and what it has', () => {
    expect(characterLabel(null)).toBe('No character');
    expect(characterLabel({ kind: 'vrm', vrm: { ...defaultVrmSettings(), model } } as CharacterConfigDTO)).toBe('3D model · kurisu_v2.vrm');
    expect(characterLabel({ kind: 'vrm' })).toBe('3D model · none uploaded');
    expect(characterLabel({ kind: 'pose_graph', pose_tree: tree } as CharacterConfigDTO)).toBe('2D pose graph · 2 poses');
    expect(characterLabel({ kind: 'pose_graph' })).toBe('No character');
  });
});

describe('what deleting a persona removes', () => {
  it('lists both members whichever shows, with sizes', () => {
    const config = { kind: 'pose_graph', pose_tree: tree, vrm: { ...defaultVrmSettings(), model, clips: [clip] } } as CharacterConfigDTO;
    expect(deletedFiles(config)).toEqual([
      { kind: 'model', text: '3D model · kurisu_v2.vrm', size: '18.4 MB' },
      { kind: 'clips', text: '1 of your own animation', size: '0.3 MB' },
      { kind: 'graph', text: 'Pose graph · 2 images, 1 video', size: '' },
    ]);
  });

  it('uses the server’s sum when it answered', () => {
    const config = { kind: 'vrm', vrm: { ...defaultVrmSettings(), model } } as CharacterConfigDTO;
    expect(deletedFiles(config, 20_000_000)[0].size).toBe('20.0 MB');
  });

  it('says so when there is nothing', () => {
    expect(deletedFiles(null)).toEqual([{ kind: 'none', text: 'No character files', size: '' }]);
  });
});
