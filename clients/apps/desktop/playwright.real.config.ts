import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The real-backend suite (#313): the specs under `tests/realBackend/`, against
 * a backend and mock Ollama already running (`KURISU_REAL_BACKEND_URL`,
 * `KURISU_MOCK_OLLAMA_URL`). `npm run test:e2e:real`; docs/testing.md.
 */
export default defineConfig({
  ...base,
  testDir: './tests/realBackend',
  testIgnore: undefined,
  // A real server answers in its own time: a turn is a database write and a
  // model round trip, where the mock answers at once.
  timeout: 60_000,
});
