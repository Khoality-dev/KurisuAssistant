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

/** Thinking condition — fires when isThinking matches the given value */
export interface ThinkingCondition {
  type: 'thinking';
  value: boolean;  // true = fires when thinking, false = fires when not thinking
}

/** Gesture condition — fires when a specific gesture is detected via camera */
export interface GestureCondition {
  type: 'gesture';
  value: string;  // gesture name: "wave", "thumbs_up", "peace_sign", "pointing", "open_palm"
}

// Extensible union
export type TransitionCondition = RandomCondition | ThinkingCondition | GestureCondition;

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

/** A single transition within an edge — each has its own condition, videos, and playback rate */
export interface EdgeTransition {
  condition: TransitionCondition;
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
  default_pose_id: string;        // Entry point node ID
  nodes: AnimationNode[];
  edges: AnimationEdge[];
}

/** Complete character configuration for one agent */
export interface CharacterConfig {
  agent_id: number;
  pose_tree: PoseTree;
}

// ─── Migration ───

/** Migrate a legacy edge (single condition/video_urls/playback_rate) to transitions[] format */
export function migrateEdgeToTransitions(edge: any): AnimationEdge {
  // Already migrated
  if (Array.isArray(edge.transitions) && edge.transitions.length > 0) {
    return edge as AnimationEdge;
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
    condition: condition || { type: 'random', min_interval_ms: 5000, max_interval_ms: 15000 },
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
