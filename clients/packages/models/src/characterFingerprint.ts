/**
 * When a persona's character has changed enough to reload it.
 *
 * The character window used to compare a pose tree by its default ids and its
 * node and edge counts, so an edit that kept the counts never reached the
 * renderer, and a config of another kind compared equal to any other of that
 * kind (#238). This is the one comparison, per kind: what a driver would load
 * differently is in the fingerprint, what only changes a label is not.
 */
import type { ParsedCharacterConfig } from './character';

/** A short, stable digest of a string (djb2); collisions are not a concern at this size. */
function digest(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function characterFingerprint(config: ParsedCharacterConfig | null): string {
  if (!config) return 'none';
  if (config.kind === 'pose_graph') {
    const tree = config.poseTree;
    if (!tree) return 'pose_graph:empty';
    // The tree's own content, not its object identity: every image and video
    // URL, every condition, every node's settings.
    return `pose_graph:${digest(JSON.stringify({
      defaults: tree.default_pose_ids,
      nodes: tree.nodes.map((n) => ({ id: n.id, pose: n.pose_config, settings: n.animation_settings })),
      edges: tree.edges,
    }))}`;
  }
  const vrm = config.vrm;
  if (!vrm) return 'vrm:empty';
  return `vrm:${vrm.model?.sha256 ?? '-'}:${digest(JSON.stringify({
    clips: vrm.clips.map((c) => `${c.id}@${c.sha256}:${c.loop}`),
    idle: vrm.idle,
    emotion: vrm.emotion,
    camera: vrm.camera,
    reactions: vrm.reactions,
  }))}`;
}
