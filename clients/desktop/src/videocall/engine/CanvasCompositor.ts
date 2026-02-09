import type { PoseConfig, ProcessedPose, LoadedPatch } from '../types';
import { getCachedImage } from './ImageCache';

type BlinkState = 'open' | 'closing' | 'closed' | 'opening';

export class CanvasCompositor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animFrameId: number | null = null;

  // Current loaded pose
  private pose: ProcessedPose | null = null;

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
    this.updateBlink(dt);
    if (this.breathingEnabled) {
      this.breathingTimer += dt;
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
        // Transition through eye patches from open→closed over ~100ms
        const closingDuration = 100;
        const progress = Math.min(this.blinkTimer / closingDuration, 1.0);
        // Map progress 0→1 to patch indices 1→numEyePatches (0 is default/open)
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
        // Stay closed for ~50ms
        if (this.blinkTimer >= 50) {
          this.blinkState = 'opening';
          this.blinkTimer = 0;
        }
        break;

      case 'opening': {
        // Transition from closed→open over ~100ms
        const openingDuration = 100;
        const progress = Math.min(this.blinkTimer / openingDuration, 1.0);
        // Map progress 0→1 to patch indices numEyePatches→0
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
    const { ctx, canvas, pose } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
    // Map amplitude 0→1 to state 0→numMouthPatches
    return Math.round(this.mouthAmplitude * numMouthPatches);
  }

  /** Load a pose configuration — fetches all images */
  async loadPose(poseConfig: PoseConfig, apiBaseUrl: string): Promise<void> {
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

    // Build LoadedPatch arrays
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

    this.pose = {
      name: poseConfig.name,
      baseImage,
      leftEyePatches,
      rightEyePatches,
      mouthPatches,
    };
  }

  /** Clear the current pose */
  clearPose(): void {
    this.pose = null;
  }

  /** Clean up resources */
  destroy(): void {
    this.stop();
    this.pose = null;
  }
}
