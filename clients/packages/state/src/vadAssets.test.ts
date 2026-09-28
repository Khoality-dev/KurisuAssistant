import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * Where speech recognition's files are fetched from (#346).
 *
 * onnxruntime imports its `.mjs` relative to its own bundle, not the page: a
 * relative `./vad/` became `assets/vad/` in a built app, where nothing is, so
 * the recogniser never loaded outside the dev server. The paths handed over
 * are absolute, resolved against the page, so they mean the same thing to
 * every loader.
 */

vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: vi.fn() } }));

import { MicVAD } from '@ricky0123/vad-web';
import { useMicStore } from './micStore';

const vadNew = MicVAD.new as unknown as Mock;
let options: any = null;

beforeEach(async () => {
  vadNew.mockReset();
  vadNew.mockImplementation(async (opts: any) => { options = opts; return { destroy: async () => {}, pause: async () => {}, start: async () => {} }; });
  await useMicStore.getState().stopListening();
});

describe("speech recognition's files", () => {
  it('are asked for by absolute URL, under the page\'s own vad/ folder', async () => {
    await useMicStore.getState().startListening();

    const expected = new URL('./vad/', document.baseURI).href;
    expect(options.baseAssetPath).toBe(expected);
    expect(options.onnxWASMBasePath).toBe(expected);
    expect(expected).toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
  });
});
