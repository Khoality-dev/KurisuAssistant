/**
 * The probe asks for WebGL 2 on a canvas of its own and gives the context back (#240).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportsWebGL } from './probe';

interface FakeCanvas {
  asked: string[];
}

function stubCanvas(contexts: Record<string, unknown>): { made: FakeCanvas[]; lose: ReturnType<typeof vi.fn> } {
  const made: FakeCanvas[] = [];
  const lose = vi.fn();
  const real = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return real(tag);
    const canvas: FakeCanvas & { getContext: (id: string) => unknown } = {
      asked: [],
      getContext(id: string) {
        canvas.asked.push(id);
        return contexts[id] ?? null;
      },
    };
    made.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  }) as typeof document.createElement);
  return { made, lose };
}

const gl2 = (lose: () => void, lost = false) => ({
  isContextLost: () => lost,
  getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: lose } : null),
});

afterEach(() => vi.restoreAllMocks());

describe('supportsWebGL', () => {
  it('is true for a WebGL 2 context, on a throwaway canvas, and releases it', () => {
    const lose = vi.fn();
    const { made } = stubCanvas({ webgl2: gl2(lose) });

    expect(supportsWebGL()).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0].asked).toEqual(['webgl2']);
    expect(lose).toHaveBeenCalledTimes(1);
  });

  it('is false on a display that offers only WebGL 1 — three.js cannot draw there — and never asks for it', () => {
    const { made } = stubCanvas({ webgl: gl2(vi.fn()) });

    expect(supportsWebGL()).toBe(false);
    expect(made[0].asked).toEqual(['webgl2']);
  });

  it('is false for a context that is already lost, and still releases it', () => {
    const lose = vi.fn();
    stubCanvas({ webgl2: gl2(lose, true) });

    expect(supportsWebGL()).toBe(false);
    expect(lose).toHaveBeenCalledTimes(1);
  });

  it('is false, not a throw, when asking throws', () => {
    vi.spyOn(document, 'createElement').mockImplementation(() => { throw new Error('no'); });

    expect(supportsWebGL()).toBe(false);
  });

  it('is false under happy-dom, whose getContext is always null', () => {
    expect(supportsWebGL()).toBe(false);
  });
});
