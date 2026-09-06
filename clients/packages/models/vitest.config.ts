import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not a DOM: nothing in this package may touch one. `protocol.test.ts`
    // reads the generated manifest off disk, which is the whole point of it.
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
