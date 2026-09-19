import { defineConfig } from 'vitest/config';

// Main-process tests: plain Node, no jsdom, no network.
export default defineConfig({
  test: { environment: 'node', include: ['test/main/**/*.test.ts'], testTimeout: 20_000 },
});
