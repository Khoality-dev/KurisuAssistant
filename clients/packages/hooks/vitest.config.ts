import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // No suite here yet. vitest exits 1 on "no test files", which would fail
    // the workspace-wide `npm test` that CI runs (#225).
    passWithNoTests: true,
  },
});
