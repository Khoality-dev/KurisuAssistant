import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom, like `ui`: `HTMLCanvasElement.getContext()` returns null
    // there, which is the point — everything testable in CI is a pure module
    // or a driver run against an injected fake renderer, never WebGL.
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
