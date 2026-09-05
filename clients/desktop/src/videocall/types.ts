/** A pre-computed patch from backend (diff of keyframe vs base, cropped to bounding box) */
export interface PatchInfo {
  image_url: string;    // URL to the cropped patch image served by backend
  x: number;            // Top-left x position on base image
  y: number;            // Top-left y position on base image
  width: number;        // Patch width
  height: number;       // Patch height
}

/** Runtime loaded patch — PatchInfo with the image already loaded */
export interface LoadedPatch {
  image: HTMLImageElement;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Configuration for a single pose (returned by backend API) */
export interface PoseConfig {
  name: string;
  base_image_url: string;         // Full portrait with default expression (eyes open, mouth closed)
  left_eye: {
    patches: PatchInfo[];         // Ordered: [half-closed, full-closed]
  };
  right_eye: {
    patches: PatchInfo[];         // Ordered: [half-closed, full-closed]
  };
  mouth: {
    patches: PatchInfo[];         // Ordered: [half-open, full-open]
  };
}

/** Runtime processed pose — all images loaded and ready to draw */
export interface ProcessedPose {
  name: string;
  baseImage: HTMLImageElement;
  leftEyePatches: LoadedPatch[];
  rightEyePatches: LoadedPatch[];
  mouthPatches: LoadedPatch[];
}

// ─── Transition Conditions ───

/** Random timer condition — fires after a random interval */
export interface RandomCondition {
  type: 'random';
  min_interval_ms: number;
  max_interval_ms: number;
}

/** Thinking condition — fires when isThinking state changes */
export interface ThinkingCondition {
  type: 'thinking';
  value: boolean;  // true = fires when thinking begins, false = fires when thinking stops
}

/** Gesture condition — fires when a specific gesture is detected via camera */
export interface GestureCondition {
  type: 'gesture';
  value: string;  // gesture name: "wave", "thumbs_up", "peace_sign", "pointing", "open_palm"
}

/** Face condition — fires when a specific face is or isn't visible via camera */
export interface FaceCondition {
  type: 'face';
  value: string;   // face identity name
  visible: boolean; // true = must be visible, false = must not be visible
}

// Extensible union
export type TransitionCondition = RandomCondition | ThinkingCondition | GestureCondition | FaceCondition;

// ─── Animation Graph ───

/** A node in the animation tree */
export interface AnimationNode {
  id: string;
  name: string;
  type: 'pose';
  pose_config?: PoseConfig;
  animation_settings?: AnimationSettings;
  position: { x: number; y: number };  // Canvas position for React Flow persistence
}

/** A single transition within an edge — each has its own conditions (AND logic), videos, and playback rate */
export interface EdgeTransition {
  conditions: TransitionCondition[];
  video_urls?: string[];
  playback_rate?: number;         // 0.25-4x, default 1.0
}

/** A directed edge between two nodes, containing one or more transitions */
export interface AnimationEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  transitions: EdgeTransition[];
}

/** Configurable animation timing for a pose node */
export interface AnimationSettings {
  breathing_enabled: boolean;      // default true
  breathing_amplitude: number;     // pixels, default 3
  breathing_period: number;        // ms, default 3500
  blink_min_interval: number;      // ms, default 2000
  blink_max_interval: number;      // ms, default 6000
  blink_close_duration: number;    // ms, default 100
  blink_hold_duration: number;     // ms, default 50
  blink_open_duration: number;     // ms, default 100
}

/** The full animation tree for a character */
export interface PoseTree {
  default_pose_ids: string[];     // Entry point node IDs (one chosen randomly at runtime)
  nodes: AnimationNode[];
  edges: AnimationEdge[];
}

/** Complete character configuration for one persona */
export interface CharacterConfig {
  persona_id: number;
  pose_tree: PoseTree;
}

// ─── Migration ───

/** Generate an 8-char random hex ID */
function randomHexId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Check if a node ID uses the old `pose-*` naming convention */
function isOldNodeId(id: string): boolean {
  return /^pose-/.test(id);
}

/** Replace old node IDs in a URL path string */
function remapUrl(url: string, idMapping: Record<string, string>): string {
  let result = url;
  for (const [oldId, newId] of Object.entries(idMapping)) {
    // Replace as path segments (e.g. /pose-default/ → /a3f4b2c1/)
    result = result.split(oldId).join(newId);
  }
  return result;
}

/**
 * Migrate old-style `pose-*` node IDs to short 8-char hex IDs.
 * Also remaps edge IDs, all URL references (images + videos), and default_pose_ids.
 * Returns the updated pose tree and the ID mapping (empty if no migration needed).
 */
export function migratePoseTreeIds(poseTree: PoseTree): {
  poseTree: PoseTree;
  idMapping: Record<string, string>;
} {
  // Check if migration is needed
  const needsMigration = poseTree.nodes.some((n) => isOldNodeId(n.id));
  if (!needsMigration) return { poseTree, idMapping: {} };

  // Build old→new mapping for all nodes
  const idMapping: Record<string, string> = {};
  for (const node of poseTree.nodes) {
    if (isOldNodeId(node.id)) {
      idMapping[node.id] = randomHexId();
    }
  }

  // Remap nodes
  const nodes: AnimationNode[] = poseTree.nodes.map((n) => {
    const newId = idMapping[n.id] || n.id;
    const newNode: AnimationNode = { ...n, id: newId };

    // Remap image URLs in pose_config
    if (newNode.pose_config) {
      const pc = { ...newNode.pose_config };
      if (pc.base_image_url) {
        pc.base_image_url = remapUrl(pc.base_image_url, idMapping);
      }
      for (const partKey of ['left_eye', 'right_eye', 'mouth'] as const) {
        if (pc[partKey]?.patches) {
          pc[partKey] = {
            ...pc[partKey],
            patches: pc[partKey].patches.map((p) => ({
              ...p,
              image_url: remapUrl(p.image_url, idMapping),
            })),
          };
        }
      }
      newNode.pose_config = pc;
    }

    return newNode;
  });

  // Build old edge ID → new edge ID mapping for video URL remapping
  const edgeIdMapping: Record<string, string> = {};

  // Remap edges
  const edges: AnimationEdge[] = poseTree.edges.map((e) => {
    const newFrom = idMapping[e.from_node_id] || e.from_node_id;
    const newTo = idMapping[e.to_node_id] || e.to_node_id;
    const newEdgeId = `${newFrom}-${newTo}`;
    edgeIdMapping[e.id] = newEdgeId;

    return {
      id: newEdgeId,
      from_node_id: newFrom,
      to_node_id: newTo,
      transitions: e.transitions.map((t) => ({
        ...t,
        video_urls: t.video_urls?.map((url) => {
          // Remap both node IDs and old edge IDs in video URLs
          let remapped = remapUrl(url, idMapping);
          remapped = remapUrl(remapped, edgeIdMapping);
          // Strip legacy "edge-" prefix from edge paths
          remapped = remapped.replace('/edges/edge-', '/edges/');
          return remapped;
        }),
      })),
    };
  });

  // Remap default_pose_ids (handle legacy single default_pose_id)
  const srcDefaults = poseTree.default_pose_ids?.length
    ? poseTree.default_pose_ids
    : [(poseTree as any).default_pose_id].filter(Boolean);
  const defaultPoseIds = srcDefaults.map(
    (id: string) => idMapping[id] || id,
  );

  return {
    poseTree: { default_pose_ids: defaultPoseIds, nodes, edges },
    idMapping,
  };
}

/** Migrate a legacy edge to current format (transitions[] with conditions[]) */
export function migrateEdgeToTransitions(edge: any): AnimationEdge {
  // Already has transitions array
  if (Array.isArray(edge.transitions) && edge.transitions.length > 0) {
    // Migrate singular condition → conditions array within each transition
    const transitions: EdgeTransition[] = edge.transitions.map((t: any) => {
      if (Array.isArray(t.conditions) && t.conditions.length > 0) return t as EdgeTransition;
      const cond: TransitionCondition = t.condition || { type: 'random', min_interval_ms: 5000, max_interval_ms: 15000 };
      const { condition: _, ...rest } = t;
      return { ...rest, conditions: [cond] } as EdgeTransition;
    });
    return { id: edge.id, from_node_id: edge.from_node_id, to_node_id: edge.to_node_id, transitions };
  }

  // Migrate legacy video_url (string) → video_urls (array)
  let videoUrls: string[] | undefined = edge.video_urls;
  if (!videoUrls?.length && edge.video_url) {
    videoUrls = [edge.video_url];
  }

  // Migrate legacy thinking trigger → value
  let condition: TransitionCondition = edge.condition;
  if (condition?.type === 'thinking' && !('value' in condition)) {
    const legacy = condition as any;
    condition = { type: 'thinking', value: legacy.trigger === 'start' };
  }

  // Build single transition from legacy fields
  const transition: EdgeTransition = {
    conditions: [condition || { type: 'random', min_interval_ms: 5000, max_interval_ms: 15000 }],
    video_urls: videoUrls,
    playback_rate: edge.playback_rate,
  };

  return {
    id: edge.id,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    transitions: [transition],
  };
}
