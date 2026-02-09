import type { PoseConfig, PoseTree, ProcessedPose, LoadedPatch, AnimationEdge } from '../types';
import { getCachedImage } from './ImageCache';

type BlinkState = 'open' | 'closing' | 'closed' | 'opening';
type CompositorState = 'idle' | 'transitioning';

interface EdgeTimer {
  elapsed: number;
  target: number;
}

export class CanvasCompositor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animFrameId: number | null = null;

  // Current loaded pose (single-pose backward compat)
  private pose: ProcessedPose | null = null;

  // Pose tree state machine
  private poseTree: PoseTree | null = null;
  private allPoses: Map<string, ProcessedPose> = new Map();
  private currentNodeId: string | null = null;
  private state: CompositorState = 'idle';
  private transitionVideo: HTMLVideoElement | null = null;
  private edgeTimers: Map<string, EdgeTimer> = new Map();
  private apiBaseUrl: string = '';

  // Blink state machine
  private blinkState: BlinkState = 'open';
  private blinkTimer = 0;
  private nextBlinkIn = 0;
  private leftEyeIndex = 0;   // 0=open (default/no patch), 1=half-closed, 2=full-closed
  private rightEyeIndex = 0;

  // Breathing animation
  private breathingTimer = 0;
  public breathingEnabled = true;
  public breathingAmplitude = 3;   // pixels of vertical sway on the original image
  public breathingPeriod = 3500;   // ms for one full cycle

  // External inputs (set by React component via setters)
  public mouthAmplitude = 0;
  public isAudioPlaying = false;
  public isThinking = false;
  private prevIsThinking = false;  // For edge detection (false→true / true→false)

  // Manual eye overrides (-1 = auto blink, 0+ = forced patch index)
  public leftEyeOverride = -1;
  public rightEyeOverride = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.scheduleNextBlink();
  }

  private scheduleNextBlink(): void {
    // Random interval: 2–6 seconds
    this.nextBlinkIn = 2000 + Math.random() * 4000;
    this.blinkTimer = 0;
  }

  /** Start the 60fps render loop */
  start(): void {
    let lastTime = performance.now();
    const loop = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      this.update(dt);
      this.draw();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  /** Stop the render loop */
  stop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private update(dt: number): void {
    if (this.state === 'idle') {
      this.updateBlink(dt);
      if (this.breathingEnabled) {
        this.breathingTimer += dt;
      }
      this.updateEdgeTimers(dt);
      this.checkThinkingEdges();
    }
    // During transitioning, skip blink/breathing/edge timer updates
  }

  private updateEdgeTimers(dt: number): void {
    if (!this.poseTree || !this.currentNodeId) return;

    // Tick all edge timers for outgoing edges from current node
    for (const [edgeId, timer] of this.edgeTimers) {
      timer.elapsed += dt;
      if (timer.elapsed >= timer.target) {
        // Find the edge
        const edge = this.poseTree.edges.find((e) => e.id === edgeId);
        if (edge) {
          this.startTransition(edge);
          return; // Only fire one transition at a time
        }
      }
    }
  }

  private checkThinkingEdges(): void {
    if (!this.poseTree || !this.currentNodeId) {
      this.prevIsThinking = this.isThinking;
      return;
    }

    const risingEdge = !this.prevIsThinking && this.isThinking;   // false→true
    const fallingEdge = this.prevIsThinking && !this.isThinking;  // true→false
    this.prevIsThinking = this.isThinking;

    if (!risingEdge && !fallingEdge) return;

    for (const edge of this.poseTree.edges) {
      if (edge.from_node_id !== this.currentNodeId) continue;
      if (edge.condition?.type !== 'thinking') continue;

      if (
        (edge.condition.trigger === 'start' && risingEdge) ||
        (edge.condition.trigger === 'end' && fallingEdge)
      ) {
        this.startTransition(edge);
        return;
      }
    }
  }

  private startTransition(edge: AnimationEdge): void {
    // Pick a random video from the list (if any)
    const urls = edge.video_urls;
    const videoUrl = urls?.length
      ? urls[Math.floor(Math.random() * urls.length)]
      : undefined;

    if (videoUrl) {
      // Play transition video
      const resolveUrl = (url: string) =>
        url.startsWith('http') ? url : `${this.apiBaseUrl}${url}`;

      this.state = 'transitioning';

      const video = document.createElement('video');
      video.muted = true; // Transition videos are silent
      video.playsInline = true;
      this.transitionVideo = video;

      // Guard against double-firing (onerror + play().catch() race)
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.switchToPose(edge.to_node_id);
      };

      video.onended = finish;
      video.onerror = () => {
        console.error('[CanvasCompositor] Transition video failed to load:', videoUrl);
        finish();
      };

      // Wait for enough data before playing
      let playStarted = false;
      const tryPlay = () => {
        if (playStarted) return;
        playStarted = true;
        video.play().catch((err) => {
          console.error('[CanvasCompositor] Transition video play() rejected:', err);
          finish();
        });
      };
      video.oncanplay = tryPlay;
      video.onloadeddata = tryPlay;

      // Set src and start loading
      video.src = resolveUrl(videoUrl);
      video.load();
    } else {
      // No video — instant switch
      this.switchToPose(edge.to_node_id);
    }
  }

  private switchToPose(nodeId: string): void {
    const newPose = this.allPoses.get(nodeId);
    if (newPose) {
      this.pose = newPose;
      this.currentNodeId = nodeId;
    }

    // Clean up video
    if (this.transitionVideo) {
      this.transitionVideo.pause();
      this.transitionVideo.src = '';
      this.transitionVideo = null;
    }

    // Reset blink
    this.blinkState = 'open';
    this.leftEyeIndex = 0;
    this.rightEyeIndex = 0;
    this.scheduleNextBlink();

    // Reset edge timers for new node's outgoing edges
    this.initEdgeTimers();

    this.state = 'idle';
  }

  private initEdgeTimers(): void {
    this.edgeTimers.clear();
    if (!this.poseTree || !this.currentNodeId) return;

    for (const edge of this.poseTree.edges) {
      if (edge.from_node_id !== this.currentNodeId) continue;
      if (!edge.condition) continue;

      if (edge.condition.type === 'random') {
        const { min_interval_ms, max_interval_ms } = edge.condition;
        const target = min_interval_ms + Math.random() * (max_interval_ms - min_interval_ms);
        this.edgeTimers.set(edge.id, { elapsed: 0, target });
      }
    }
  }

  private updateBlink(dt: number): void {
    this.blinkTimer += dt;
    const numEyePatches = this.pose ? this.pose.leftEyePatches.length : 0;

    // If no eye patches, no blinking
    if (numEyePatches === 0) {
      this.leftEyeIndex = 0;
      this.rightEyeIndex = 0;
      return;
    }

    switch (this.blinkState) {
      case 'open':
        this.leftEyeIndex = 0;
        this.rightEyeIndex = 0;
        if (this.blinkTimer >= this.nextBlinkIn) {
          this.blinkState = 'closing';
          this.blinkTimer = 0;
        }
        break;

      case 'closing': {
        const closingDuration = 100;
        const progress = Math.min(this.blinkTimer / closingDuration, 1.0);
        const idx = Math.min(Math.round(progress * numEyePatches), numEyePatches);
        this.leftEyeIndex = idx;
        this.rightEyeIndex = idx;
        if (this.blinkTimer >= closingDuration) {
          this.blinkState = 'closed';
          this.blinkTimer = 0;
        }
        break;
      }

      case 'closed':
        this.leftEyeIndex = numEyePatches;
        this.rightEyeIndex = numEyePatches;
        if (this.blinkTimer >= 50) {
          this.blinkState = 'opening';
          this.blinkTimer = 0;
        }
        break;

      case 'opening': {
        const openingDuration = 100;
        const progress = Math.min(this.blinkTimer / openingDuration, 1.0);
        const idx = Math.max(Math.round((1 - progress) * numEyePatches), 0);
        this.leftEyeIndex = idx;
        this.rightEyeIndex = idx;
        if (this.blinkTimer >= openingDuration) {
          this.leftEyeIndex = 0;
          this.rightEyeIndex = 0;
          this.blinkState = 'open';
          this.blinkTimer = 0;
          this.scheduleNextBlink();
        }
        break;
      }
    }
  }

  private draw(): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // During transition, draw the video frame (or keep showing current pose while loading)
    if (this.state === 'transitioning' && this.transitionVideo) {
      const video = this.transitionVideo;
      if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return;
      }
      // Video not ready yet — fall through to draw current pose
    }

    const pose = this.pose;
    if (!pose) return;

    // Compute scale factors for patches (since we scale the base to canvas size)
    const scaleX = canvas.width / pose.baseImage.naturalWidth;
    const scaleY = canvas.height / pose.baseImage.naturalHeight;

    // Breathing offset — gentle vertical sine wave applied to everything
    let breathingOffsetY = 0;
    if (this.breathingEnabled && this.breathingPeriod > 0) {
      const phase = (this.breathingTimer / this.breathingPeriod) * Math.PI * 2;
      breathingOffsetY = Math.sin(phase) * this.breathingAmplitude * scaleY;
    }

    ctx.save();
    ctx.translate(0, breathingOffsetY);

    // Layer 1: Base portrait (full image with default expression)
    ctx.drawImage(pose.baseImage, 0, 0, canvas.width, canvas.height);

    // Layer 2: Left eye patch (override or blink state)
    const leftIdx = this.leftEyeOverride >= 0 ? this.leftEyeOverride : this.leftEyeIndex;
    if (leftIdx > 0 && leftIdx <= pose.leftEyePatches.length) {
      const patch = pose.leftEyePatches[leftIdx - 1];
      this.drawPatch(ctx, patch, scaleX, scaleY);
    }

    // Layer 3: Right eye patch (override or blink state)
    const rightIdx = this.rightEyeOverride >= 0 ? this.rightEyeOverride : this.rightEyeIndex;
    if (rightIdx > 0 && rightIdx <= pose.rightEyePatches.length) {
      const patch = pose.rightEyePatches[rightIdx - 1];
      this.drawPatch(ctx, patch, scaleX, scaleY);
    }

    // Layer 4: Mouth patch (if not default state)
    const mouthState = this.getMouthState();
    if (mouthState > 0 && mouthState <= pose.mouthPatches.length) {
      const patch = pose.mouthPatches[mouthState - 1];
      this.drawPatch(ctx, patch, scaleX, scaleY);
    }

    ctx.restore();
  }

  private drawPatch(
    ctx: CanvasRenderingContext2D,
    patch: LoadedPatch,
    scaleX: number,
    scaleY: number,
  ): void {
    ctx.drawImage(
      patch.image,
      patch.x * scaleX,
      patch.y * scaleY,
      patch.width * scaleX,
      patch.height * scaleY,
    );
  }

  private getMouthState(): number {
    if (!this.isAudioPlaying || !this.pose) return 0;
    const numMouthPatches = this.pose.mouthPatches.length;
    if (numMouthPatches === 0) return 0;
    return Math.round(this.mouthAmplitude * numMouthPatches);
  }

  /** Load a single pose configuration — fetches all images (backward compat) */
  async loadPose(poseConfig: PoseConfig, apiBaseUrl: string): Promise<void> {
    this.apiBaseUrl = apiBaseUrl;
    const processed = await this.processPoseConfig(poseConfig, apiBaseUrl);
    this.pose = processed;
    // Clear tree state when loading single pose
    this.poseTree = null;
    this.allPoses.clear();
    this.currentNodeId = null;
    this.edgeTimers.clear();
    this.state = 'idle';
  }

  /** Load a full pose tree — fetches all images for all nodes, sets up state machine */
  async loadPoseTree(poseTree: PoseTree, apiBaseUrl: string): Promise<void> {
    this.apiBaseUrl = apiBaseUrl;
    this.poseTree = poseTree;
    this.allPoses.clear();
    this.edgeTimers.clear();

    // Clean up any existing transition video
    if (this.transitionVideo) {
      this.transitionVideo.pause();
      this.transitionVideo.src = '';
      this.transitionVideo = null;
    }

    // Load all pose nodes in parallel
    const loadPromises = poseTree.nodes
      .filter((n) => n.pose_config)
      .map(async (node) => {
        const processed = await this.processPoseConfig(node.pose_config!, apiBaseUrl);
        this.allPoses.set(node.id, processed);
      });

    await Promise.all(loadPromises);

    // Set current node to default
    this.currentNodeId = poseTree.default_pose_id;
    this.pose = this.allPoses.get(poseTree.default_pose_id) || null;

    // Reset blink state
    this.blinkState = 'open';
    this.leftEyeIndex = 0;
    this.rightEyeIndex = 0;
    this.scheduleNextBlink();

    // Initialize edge timers
    this.initEdgeTimers();

    this.state = 'idle';
  }

  /** Process a PoseConfig into a ProcessedPose (load all images) */
  private async processPoseConfig(poseConfig: PoseConfig, apiBaseUrl: string): Promise<ProcessedPose> {
    const resolveUrl = (url: string) =>
      url.startsWith('http') ? url : `${apiBaseUrl}${url}`;

    // Load all images in parallel
    const [baseImage, ...leftEyeImages] = await Promise.all([
      getCachedImage(resolveUrl(poseConfig.base_image_url)),
      ...poseConfig.left_eye.patches.map((p) => getCachedImage(resolveUrl(p.image_url))),
    ]);

    const rightEyeImages = await Promise.all(
      poseConfig.right_eye.patches.map((p) => getCachedImage(resolveUrl(p.image_url))),
    );

    const mouthImages = await Promise.all(
      poseConfig.mouth.patches.map((p) => getCachedImage(resolveUrl(p.image_url))),
    );

    const leftEyePatches: LoadedPatch[] = poseConfig.left_eye.patches.map((p, i) => ({
      image: leftEyeImages[i],
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
    }));

    const rightEyePatches: LoadedPatch[] = poseConfig.right_eye.patches.map((p, i) => ({
      image: rightEyeImages[i],
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
    }));

    const mouthPatches: LoadedPatch[] = poseConfig.mouth.patches.map((p, i) => ({
      image: mouthImages[i],
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
    }));

    return {
      name: poseConfig.name,
      baseImage,
      leftEyePatches,
      rightEyePatches,
      mouthPatches,
    };
  }

  /** Get the current processed pose (for reading base image dimensions etc.) */
  getPose(): ProcessedPose | null {
    return this.pose;
  }

  /** Clear the current pose */
  clearPose(): void {
    this.pose = null;
    this.poseTree = null;
    this.allPoses.clear();
    this.currentNodeId = null;
    this.edgeTimers.clear();
    this.state = 'idle';
    if (this.transitionVideo) {
      this.transitionVideo.pause();
      this.transitionVideo.src = '';
      this.transitionVideo = null;
    }
  }

  /** Clean up resources */
  destroy(): void {
    this.stop();
    this.clearPose();
  }
}
