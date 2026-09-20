/**
 * Whether this display can draw a 3D character at all.
 *
 * Asked BEFORE the three.js chunk is imported: on a machine without hardware
 * graphics, and under happy-dom where `getContext()` is always null, the
 * surface shows a sentence instead of a black box and never loads the engine.
 */
export function supportsWebGL(canvas: HTMLCanvasElement): boolean {
  try {
    const attrs = { failIfMajorPerformanceCaveat: false } as const;
    const gl = canvas.getContext('webgl2', attrs) ?? canvas.getContext('webgl', attrs);
    if (!gl) return false;
    // A context handed back but already lost is no context.
    const lost = (gl as WebGLRenderingContext).isContextLost?.();
    return !lost;
  } catch {
    return false;
  }
}
