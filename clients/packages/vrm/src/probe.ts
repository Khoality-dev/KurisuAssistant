/**
 * Whether this display can draw a 3D character at all.
 *
 * Asked BEFORE the three.js chunk is imported: on a machine without hardware
 * graphics, and under happy-dom where `getContext()` is always null, the
 * surface shows a sentence instead of a black box and never loads the engine.
 * Reached as `@kurisu/vrm/probe` — this file imports nothing, and the package
 * root is not the way in, because that would carry the engine with the
 * question.
 *
 * WebGL 2 only: three.js 0.186 has no WebGL 1 renderer, so a display that can
 * offer only `webgl` cannot draw the character and must be told so rather than
 * fail later. And on a canvas of its own, thrown away afterwards: a context is
 * pinned to the canvas that first asked for it, with the attributes of that
 * request, so probing the stage's canvas would hand the renderer this probe's
 * context and discard the attributes the renderer asks for. The throwaway's
 * context is released at once with `WEBGL_lose_context`, so the probe does not
 * hold one of the browser's few contexts until garbage collection.
 */
export function supportsWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
    if (!gl) return false;
    // A context handed back but already lost is no context.
    const usable = !gl.isContextLost?.();
    gl.getExtension?.('WEBGL_lose_context')?.loseContext();
    return usable;
  } catch {
    return false;
  }
}
