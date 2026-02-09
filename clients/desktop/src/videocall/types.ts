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

/** A node in the animation tree */
export interface AnimationNode {
  id: string;
  name: string;
  type: 'pose' | 'leaf';
  // For pose nodes: has PoseConfig (lip sync + blink)
  // For leaf nodes: just a state marker (no lip sync)
  pose_config?: PoseConfig;
}

/** A directed edge = a video/sprite transition between two nodes */
export interface AnimationEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  video_url?: string;             // Video clip for this transition
  frame_urls?: string[];          // OR sprite sequence frames
  fps: number;                    // Playback speed (default 24)
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
