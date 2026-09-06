import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The same renderer, built for a browser.
 *
 * The only difference from `vite.config.ts` is what is *not* here: no
 * `vite-plugin-electron`, no `vite-plugin-electron-renderer`. The renderer was
 * always browser code — the host-specific parts reach it through
 * `resolveBridge()` — so nothing in `src/` changes shape for this build.
 *
 * Output goes to `dist-web/` so an Electron build and a browser build can sit
 * side by side without one overwriting the other's `dist/`.
 */
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
  },
});
