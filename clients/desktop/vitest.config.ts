import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    // `tests/` also holds the Playwright specs, which are matched by `.spec.ts`
    // in playwright.config.ts. Only `.test.ts` there is vitest's — that is how the
    // mock backend gets unit-tested without an Electron build.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.test.ts'],
  },
});
