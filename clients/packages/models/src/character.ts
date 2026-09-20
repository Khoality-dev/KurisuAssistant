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

/**
 * When and how fast the eyes close. Shared by both character kinds, so the
 * persisted keys are the 2D rig's own and a VRM blinks on the same clock.
 */
export interface BlinkTiming {
  blink_min_interval: number;      // ms, default 2000
  blink_max_interval: number;      // ms, default 6000
  blink_close_duration: number;    // ms, default 100
  blink_hold_duration: number;     // ms, default 50
  blink_open_duration: number;     // ms, default 100
}

/** Configurable animation timing for a pose node */
export interface AnimationSettings extends BlinkTiming {
  breathing_enabled: boolean;      // default true
  breathing_amplitude: number;     // pixels, default 3
  breathing_period: number;        // ms, default 3500
}

/** The full animation tree for a character */
export interface PoseTree {
  default_pose_ids: string[];     // Entry point node IDs (one chosen randomly at runtime)
  nodes: AnimationNode[];
  edges: AnimationEdge[];
}

// ─── The character config: which system a persona uses, and each system's settings ───

/** Which character system a persona shows. Wire protocol 7 made it required (#235). */
export type CharacterKind = 'pose_graph' | 'vrm';

/**
 * The VRM 1.0 preset expressions plus neutral. A VRM 0.x model has no `surprised`;
 * the renderer degrades a preset the model lacks, the wire set does not shrink.
 */
export type VrmEmotion = 'neutral' | 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised';
export const VRM_EMOTIONS: readonly VrmEmotion[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

/**
 * Where the persona's feeling changed inside an assistant message (#243).
 *
 * The backend strips the tags the model wrote and reports each one as a cue:
 * the label, and `at`, an offset into the message's clean text — in UTF-16
 * code units, i.e. `String.length`, so slicing the accumulated text at `at`
 * is exact. A stream carries them one per `stream_chunk` (`emotion` /
 * `emotion_at`, the chunk's content starting at that offset); the history
 * carries the whole list on the message (`emotion_cues`). Applying a cue to a
 * face when the sentence is *spoken*, not when its text arrives, is #244.
 */
export interface EmotionCue {
  emotion: VrmEmotion;
  at: number;
}

/**
 * The five gesture names the vision pipeline emits (backend
 * `models/gesture_detection/classifier.py`). One copy, for every editor that
 * offers them.
 */
export const GESTURE_NAMES = ['wave', 'thumbs_up', 'peace_sign', 'pointing', 'open_palm'] as const;
export type GestureName = (typeof GESTURE_NAMES)[number];

/**
 * SERVER-OWNED. Written by the model upload route in the transaction that accepts
 * the bytes. A saved body must leave it out, send null, or echo exactly what
 * GET /personas returned (a partial echo is 422); the stored value wins either way.
 */
export interface VrmAssetRef {
  url: string;          // '/character-assets/{persona_id}/vrm/model' — root-relative, extension-less
  sha256: string;       // the ETag, the cache key; validated `^[0-9a-f]{64}$` before it names a file
  bytes: number;
  uploaded_at: string;  // ISO-8601
}

/** SERVER-OWNED like `VrmAssetRef`; `name` and `loop` are edited through the clip routes. */
export interface VrmClipRef {
  id: string;           // 8 hex chars, server-generated
  name: string;
  url: string;          // '/character-assets/{persona_id}/vrma/{id}'
  sha256: string;
  bytes: number;
  loop: boolean;
}

export interface VrmReaction {
  id: string;
  name: string;
  /** The same condition objects the 2D graph uses, AND-ed; first match wins. */
  when: TransitionCondition[];
  play:
    | { type: 'clip'; clip_id: string; crossfade_ms?: number }
    | { type: 'expression'; expression: VrmEmotion; weight: number; hold_ms: number };
  cooldown_ms: number;  // default 4000
}

export interface VrmIdleSettings {
  procedural: boolean;              // breathing + sway + look-at
  arms_lowered: boolean;            // A/T-pose correction at load
  breath_period_ms: number;         // 4000
  breath_amplitude_deg: number;     // 2 — chest pitch in degrees; the VRM rig carries rotations, not scale
  sway_amplitude_deg: number;       // 1.5
  sway_period_ms: number;           // 7000
  blink: BlinkTiming;
  look_at: 'camera' | 'drift' | 'off';
  idle_clip_ids: string[];          // [] = procedural only
  idle_clip_interval_ms: [number, number];
}

export interface VrmEmotionSettings {
  enabled: boolean;
  default_expression: VrmEmotion;
  intensity: number;                // 0..1
  attack_ms: number;                // 180
  release_ms: number;               // 400
  thinking?: VrmEmotion | null;
}

export interface VrmCamera {
  target: 'head' | 'upper_body' | 'full_body';
  fov: number;                      // 24
  offset_y: number;                 // metres
  background: string;               // '#ffffff'
}

export interface VrmSettings {
  model: VrmAssetRef | null;        // null until the first upload
  clips: VrmClipRef[];
  idle: VrmIdleSettings;
  emotion: VrmEmotionSettings;
  reactions: VrmReaction[];
  camera: VrmCamera;
}

/**
 * `personas.character_config`. `kind` selects what renders; the two members are
 * kept side by side so switching back needs no upload. A save is a merge: a
 * member left out is kept, `null` clears it, and `kind` may change on its own.
 */
export interface CharacterConfig {
  kind: CharacterKind;
  pose_tree?: PoseTree | null;
  vrm?: VrmSettings | null;
}

/** What a reader gets: the selector plus both members, absent ones as null. */
export interface ParsedCharacterConfig {
  kind: CharacterKind;
  poseTree: PoseTree | null;
  vrm: VrmSettings | null;
}

/**
 * The ONE reader of a persona's `character_config`.
 *
 * Returns null for null, a non-object, and anything without a recognised
 * `kind` — there is no kind-less fallback: the backend stamps every row and
 * refuses a save without one (wire protocol 7), so a config with no `kind` is
 * not "a pose graph from before", it is something this client cannot classify.
 */
export function parseCharacterConfig(dto: unknown): ParsedCharacterConfig | null {
  if (!dto || typeof dto !== 'object') return null;
  const c = dto as Record<string, unknown>;
  const kind = c.kind;
  if (kind !== 'pose_graph' && kind !== 'vrm') return null;
  const poseTree = c.pose_tree && typeof c.pose_tree === 'object' ? (c.pose_tree as PoseTree) : null;
  const vrm = c.vrm && typeof c.vrm === 'object' ? (c.vrm as VrmSettings) : null;
  return { kind, poseTree, vrm };
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

/**
 * What the mouth and the thinking indicator are doing right now.
 *
 * Sampled per animation frame and sent to whatever is drawing the character —
 * a second window on the desktop, an inline panel elsewhere — so it is a wire
 * shape, not a component's private state.
 */
export interface AmplitudeState {
  amplitude: number;
  isPlaying: boolean;
  isThinking: boolean;
}
