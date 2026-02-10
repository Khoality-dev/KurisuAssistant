import type { PoseConfig, PoseTree, ProcessedPose, LoadedPatch, AnimationEdge, AnimationSettings } from '../types';
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
  private videoBlobCache: Map<string, { hash: string; blobUrl: string }> = new Map();

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

  // Blink timing (configurable per-node)
  public blinkMinInterval = 2000;    // ms
  public blinkMaxInterval = 6000;    // ms
  public blinkCloseDuration = 100;   // ms
  public blinkHoldDuration = 50;     // ms
  public blinkOpenDuration = 100;    // ms

  // External inputs (set by React component via setters)
  public mouthAmplitude = 0;
  public isAudioPlaying = false;
  public isThinking = false;

  // Manual eye overrides (-1 = auto blink, 0+ = forced patch index)
  public leftEyeOverride = -1;
  public rightEyeOverride = -1;

  // Crossfade blending
  private crossfadeCanvas: OffscreenCanvas | null = null;
  private crossfadeCtx: OffscreenCanvasRenderingContext2D | null = null;
  private crossfadeProgress = 1;  // 1 = no crossfade active
  private crossfadeDuration = 150; // ms

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.scheduleNextBlink();
  }

  private scheduleNextBlink(): void {
    this.nextBlinkIn = this.blinkMinInterval + Math.random() * (this.blinkMaxInterval - this.blinkMinInterval);
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
    // Always tick crossfade
    if (this.crossfadeProgress < 1) {
      this.crossfadeProgress = Math.min(this.crossfadeProgress + dt / this.crossfadeDuration, 1);
    }

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

  /** Snapshot the current canvas content for crossfade blending */
  private captureForCrossfade(): void {
    if (!this.crossfadeCanvas) {
      this.crossfadeCanvas = new OffscreenCanvas(this.canvas.width, this.canvas.height);
      this.crossfadeCtx = this.crossfadeCanvas.getContext('2d')!;
    }
    this.crossfadeCanvas.width = this.canvas.width;
    this.crossfadeCanvas.height = this.canvas.height;
    this.crossfadeCtx!.drawImage(this.canvas, 0, 0);
    this.crossfadeProgress = 0;
  }

  private updateEdgeTimers(dt: number): void {
    if (!this.poseTree || !this.currentNodeId) return;

    // Tick all timers and collect ready edges
    const ready: AnimationEdge[] = [];
    for (const [edgeId, timer] of this.edgeTimers) {
      timer.elapsed += dt;
      if (timer.elapsed >= timer.target) {
        const edge = this.poseTree.edges.find((e) => e.id === edgeId);
        if (edge) ready.push(edge);
      }
    }

    if (ready.length > 0) {
      this.startTransition(ready[Math.floor(Math.random() * ready.length)]);
    }
  }

  private checkThinkingEdges(): void {
    if (!this.poseTree || !this.currentNodeId) return;

    const matched: AnimationEdge[] = [];
    for (const edge of this.poseTree.edges) {
      if (edge.from_node_id !== this.currentNodeId) continue;
      if (edge.condition?.type !== 'thinking') continue;
      if (edge.condition.value === this.isThinking) matched.push(edge);
    }

    if (matched.length > 0) {
      this.startTransition(matched[Math.floor(Math.random() * matched.length)]);
    }
  }

  private startTransition(edge: AnimationEdge): void {
    this.captureForCrossfade();

    // Pick a random video from the list (if any)
    const urls = edge.video_urls;
    const videoUrl = urls?.length
      ? urls[Math.floor(Math.random() * urls.length)]
      : undefined;

    if (videoUrl) {
      const resolvedUrl = videoUrl.startsWith('http') ? videoUrl : `${this.apiBaseUrl}${videoUrl}`;
      const blobUrl = this.videoBlobCache.get(resolvedUrl)?.blobUrl;

      if (!blobUrl) {
        // Not cached — skip video, instant switch
        this.switchToPose(edge.to_node_id);
        return;
      }

      this.state = 'transitioning';

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.playbackRate = edge.playback_rate ?? 1.0;
      this.transitionVideo = video;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.switchToPose(edge.to_node_id);
      };

      video.onended = finish;
      video.onerror = () => {
        console.error('[CanvasCompositor] Transition video playback failed:', videoUrl);
        finish();
      };

      video.src = blobUrl;
      video.play().catch((err) => {
        console.error('[CanvasCompositor] Transition video play() rejected:', err);
        finish();
      });
    } else {
      // No video — instant switch
      this.switchToPose(edge.to_node_id);
    }
  }

  private switchToPose(nodeId: string): void {
    this.captureForCrossfade();

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

    // Apply per-node animation settings
    const node = this.poseTree?.nodes.find((n) => n.id === nodeId);
    if (node?.animation_settings) {
      this.applySettings(node.animation_settings);
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
        const progress = Math.min(this.blinkTimer / this.blinkCloseDuration, 1.0);
        const idx = Math.min(Math.round(progress * numEyePatches), numEyePatches);
        this.leftEyeIndex = idx;
        this.rightEyeIndex = idx;
        if (this.blinkTimer >= this.blinkCloseDuration) {
          this.blinkState = 'closed';
          this.blinkTimer = 0;
        }
        break;
      }

      case 'closed':
        this.leftEyeIndex = numEyePatches;
        this.rightEyeIndex = numEyePatches;
        if (this.blinkTimer >= this.blinkHoldDuration) {
          this.blinkState = 'opening';
          this.blinkTimer = 0;
        }
        break;

      case 'opening': {
        const progress = Math.min(this.blinkTimer / this.blinkOpenDuration, 1.0);
        const idx = Math.max(Math.round((1 - progress) * numEyePatches), 0);
        this.leftEyeIndex = idx;
        this.rightEyeIndex = idx;
        if (this.blinkTimer >= this.blinkOpenDuration) {
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
        this.drawCrossfade(ctx, canvas);
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

    this.drawCrossfade(ctx, canvas);
  }

  /** Overlay fading snapshot of previous state for smooth blending */
  private drawCrossfade(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (this.crossfadeProgress >= 1 || !this.crossfadeCanvas) return;
    ctx.save();
    ctx.globalAlpha = 1 - this.crossfadeProgress;
    ctx.drawImage(this.crossfadeCanvas, 0, 0, canvas.width, canvas.height);
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

    // Migrate legacy thinking trigger → value
    for (const edge of poseTree.edges) {
      if (edge.condition?.type === 'thinking' && !('value' in edge.condition)) {
        const legacy = edge.condition as any;
        edge.condition = { type: 'thinking', value: legacy.trigger === 'start' };
      }
    }

    // Collect all unique video URLs from edges
    const resolveUrl = (url: string) =>
      url.startsWith('http') ? url : `${apiBaseUrl}${url}`;
    const videoUrls = new Set<string>();
    for (const edge of poseTree.edges) {
      for (const url of edge.video_urls || []) {
        videoUrls.add(resolveUrl(url));
      }
    }

    // Load all pose images + pre-fetch uncached videos in parallel
    const imagePromises = poseTree.nodes
      .filter((n) => n.pose_config)
      .map(async (node) => {
        const processed = await this.processPoseConfig(node.pose_config!, apiBaseUrl);
        this.allPoses.set(node.id, processed);
      });

    const videoPromises = [...videoUrls].map(async (url) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const blob = await resp.blob();
        const hashBuffer = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        const hash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

        const cached = this.videoBlobCache.get(url);
        if (cached && cached.hash === hash) return; // Same content, keep existing blob

        // New or changed — revoke old and store new
        if (cached) URL.revokeObjectURL(cached.blobUrl);
        this.videoBlobCache.set(url, { hash, blobUrl: URL.createObjectURL(blob) });
      } catch {
        // Video will be skipped during playback if not cached
      }
    });

    await Promise.all([...imagePromises, ...videoPromises]);

    // Set current node to default
    this.currentNodeId = poseTree.default_pose_id;
    this.pose = this.allPoses.get(poseTree.default_pose_id) || null;

    // Apply default node's animation settings
    const defaultNode = poseTree.nodes.find((n) => n.id === poseTree.default_pose_id);
    if (defaultNode?.animation_settings) {
      this.applySettings(defaultNode.animation_settings);
    }

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

  /** Apply per-node animation settings */
  applySettings(settings: Partial<AnimationSettings>): void {
    if (settings.breathing_enabled !== undefined) this.breathingEnabled = settings.breathing_enabled;
    if (settings.breathing_amplitude !== undefined) this.breathingAmplitude = settings.breathing_amplitude;
    if (settings.breathing_period !== undefined) this.breathingPeriod = settings.breathing_period;
    if (settings.blink_min_interval !== undefined) this.blinkMinInterval = settings.blink_min_interval;
    if (settings.blink_max_interval !== undefined) this.blinkMaxInterval = settings.blink_max_interval;
    if (settings.blink_close_duration !== undefined) this.blinkCloseDuration = settings.blink_close_duration;
    if (settings.blink_hold_duration !== undefined) this.blinkHoldDuration = settings.blink_hold_duration;
    if (settings.blink_open_duration !== undefined) this.blinkOpenDuration = settings.blink_open_duration;
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
    // Keep video blob cache — videos are expensive to re-fetch
  }

  /** Clean up resources */
  destroy(): void {
    this.stop();
    this.clearPose();
    for (const { blobUrl } of this.videoBlobCache.values()) {
      URL.revokeObjectURL(blobUrl);
    }
    this.videoBlobCache.clear();
  }
}
