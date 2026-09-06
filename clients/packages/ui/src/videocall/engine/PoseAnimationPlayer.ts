/**
 * Stub for Phase 3 — plays sprite sequence or video for edge transitions.
 * Currently unused. Will be implemented when pose animations are added.
 */
export class PoseAnimationPlayer {
  private frames: HTMLImageElement[] = [];
  private frameDuration: number;
  private currentFrameIndex = 0;
  private elapsed = 0;
  private finished = false;

  constructor(frames: HTMLImageElement[], fps: number = 24) {
    this.frames = frames;
    this.frameDuration = 1000 / fps;
  }

  update(dt: number): void {
    if (this.finished) return;
    this.elapsed += dt;
    this.currentFrameIndex = Math.floor(this.elapsed / this.frameDuration);
    if (this.currentFrameIndex >= this.frames.length) {
      this.currentFrameIndex = this.frames.length - 1;
      this.finished = true;
    }
  }

  getCurrentFrame(): HTMLImageElement | null {
    return this.frames[this.currentFrameIndex] || null;
  }

  isFinished(): boolean {
    return this.finished;
  }
}
