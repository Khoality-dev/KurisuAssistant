/**
 * The stage: one scene, one camera framed on the character, three lights.
 *
 * Framing is computed from the model itself — the normalised humanoid's head,
 * chest and hips heights — so a tall model and a chibi one both fill the box
 * the same way, and a resize re-frames rather than assuming the window's
 * shape. The renderer comes from a factory so the whole stage runs headless
 * under happy-dom against a fake.
 */
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { VrmCamera } from '@kurisu/models';

/** The slice of `THREE.WebGLRenderer` the driver uses; a fake implements this. */
export interface StageRenderer {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  dispose(): void;
  forceContextLoss?(): void;
}

export type RendererFactory = (canvas: HTMLCanvasElement) => StageRenderer;

export const defaultRendererFactory: RendererFactory = (canvas) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
};

export interface Stage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Where the eyes look when `look_at` is `camera`: a point at the lens. */
  gazeTarget: THREE.Object3D;
  renderer: StageRenderer;
  width: number;
  height: number;
}

const DEFAULT_CAMERA: VrmCamera = { target: 'upper_body', fov: 24, offset_y: 0, background: '#ffffff' };

export function createStage(canvas: HTMLCanvasElement, makeRenderer: RendererFactory, cameraCfg: Partial<VrmCamera> | null | undefined): Stage {
  const cfg = { ...DEFAULT_CAMERA, ...(cameraCfg ?? {}) };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(cfg.background || DEFAULT_CAMERA.background);

  const camera = new THREE.PerspectiveCamera(cfg.fov || DEFAULT_CAMERA.fov, 1, 0.05, 50);
  camera.position.set(0, 1.4, 2.5);

  const gazeTarget = new THREE.Object3D();
  gazeTarget.name = 'gaze';
  camera.add(gazeTarget);
  scene.add(camera);

  // Soft key from the front-top, a cool fill from the side, and an ambient
  // floor: enough for MToon to read, nothing dramatic.
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.5, 1.8, 1.5);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
  fill.position.set(-1.2, 1.0, 0.8);
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(key, fill, ambient);

  const renderer = makeRenderer(canvas);
  return { scene, camera, gazeTarget, renderer, width: 1, height: 1 };
}

/** World-space y of a normalised bone, or a fallback when the model lacks it. */
function boneY(vrm: VRM, name: Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0], fallback: number): number {
  const node = vrm.humanoid.getNormalizedBoneNode(name);
  if (!node) return fallback;
  const p = new THREE.Vector3();
  node.getWorldPosition(p);
  return p.y;
}

/**
 * Put the camera where `target` asks, using the model's own proportions.
 * Called after load and on every resize.
 */
export function frameCamera(stage: Stage, vrm: VRM, cameraCfg: Partial<VrmCamera> | null | undefined): void {
  const cfg = { ...DEFAULT_CAMERA, ...(cameraCfg ?? {}) };
  vrm.scene.updateWorldMatrix(true, true);
  const head = boneY(vrm, 'head', 1.5);
  const chest = boneY(vrm, 'chest', boneY(vrm, 'spine', head * 0.7));
  const hips = boneY(vrm, 'hips', head * 0.55);
  const top = head + 0.12; // crown, roughly

  let centreY: number;
  let extent: number; // vertical extent to fit, metres
  switch (cfg.target) {
    case 'head':
      centreY = head + 0.02;
      extent = 0.42;
      break;
    case 'full_body':
      centreY = top / 2;
      extent = top + 0.1;
      break;
    case 'upper_body':
    default:
      centreY = (top + hips) / 2 + (chest - hips) * 0.1;
      extent = (top - hips) * 1.15;
      break;
  }
  centreY += cfg.offset_y || 0;

  const fovRad = ((cfg.fov || DEFAULT_CAMERA.fov) * Math.PI) / 180;
  const aspect = stage.width / Math.max(1, stage.height);
  // Fit the extent vertically, and if the box is narrow, horizontally too.
  const fitHeight = extent / (2 * Math.tan(fovRad / 2));
  const fitWidth = (extent * 0.7) / (2 * Math.tan(fovRad / 2) * Math.max(0.1, aspect));
  const distance = Math.max(fitHeight, fitWidth) * 1.05;

  stage.camera.fov = cfg.fov || DEFAULT_CAMERA.fov;
  stage.camera.aspect = Math.max(0.1, aspect);
  stage.camera.position.set(0, centreY, distance);
  stage.camera.lookAt(0, centreY, 0);
  stage.camera.updateProjectionMatrix();
  stage.gazeTarget.position.set(0, 0, 0);
  stage.scene.background = new THREE.Color(cfg.background || DEFAULT_CAMERA.background);
}

export function resizeStage(stage: Stage, cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
  stage.width = Math.max(1, Math.floor(cssWidth));
  stage.height = Math.max(1, Math.floor(cssHeight));
  stage.renderer.setPixelRatio(Math.min(Math.max(1, devicePixelRatio || 1), 2));
  stage.renderer.setSize(stage.width, stage.height, false);
  stage.camera.aspect = stage.width / stage.height;
  stage.camera.updateProjectionMatrix();
}
