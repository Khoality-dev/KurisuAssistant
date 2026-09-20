/**
 * `parseCharacterConfig` is the one place a persona's `character_config` is read.
 *
 * Before #235 three files each reached into the bag for `pose_tree` by name and
 * nothing said what a config *was*. Now the backend stamps every row with a
 * `kind` and refuses a save without one (wire protocol 7), so the reader has no
 * fallback to offer: a config it cannot classify is null, and a VRM persona is
 * recognised as one rather than read as "no character".
 */
import { describe, expect, it } from 'vitest';
import { parseCharacterConfig, type PoseTree, type VrmSettings } from './character';

const tree: PoseTree = { default_pose_ids: [], nodes: [], edges: [] };
const vrm = { model: null, clips: [], reactions: [] } as unknown as VrmSettings;

describe('parseCharacterConfig', () => {
  it('is null for nothing, a non-object, a missing kind and an unknown kind', () => {
    expect(parseCharacterConfig(null)).toBeNull();
    expect(parseCharacterConfig(undefined)).toBeNull();
    expect(parseCharacterConfig('pose_graph')).toBeNull();
    expect(parseCharacterConfig({ pose_tree: tree })).toBeNull();
    expect(parseCharacterConfig({ kind: 'hologram', pose_tree: tree })).toBeNull();
  });

  it('reads a pose graph', () => {
    expect(parseCharacterConfig({ kind: 'pose_graph', pose_tree: tree })).toEqual({
      kind: 'pose_graph',
      poseTree: tree,
      vrm: null,
    });
  });

  it('reads a VRM config', () => {
    expect(parseCharacterConfig({ kind: 'vrm', vrm })).toEqual({ kind: 'vrm', poseTree: null, vrm });
  });

  it('keeps both members when a persona holds both, whichever is selected', () => {
    expect(parseCharacterConfig({ kind: 'vrm', pose_tree: tree, vrm })).toEqual({
      kind: 'vrm',
      poseTree: tree,
      vrm,
    });
    expect(parseCharacterConfig({ kind: 'pose_graph', pose_tree: tree, vrm })?.vrm).toBe(vrm);
  });

  it('treats an explicit null member and a non-object member as absent', () => {
    expect(parseCharacterConfig({ kind: 'pose_graph', pose_tree: null, vrm: null })).toEqual({
      kind: 'pose_graph',
      poseTree: null,
      vrm: null,
    });
    expect(parseCharacterConfig({ kind: 'vrm', vrm: 'soon' })?.vrm).toBeNull();
  });
});
