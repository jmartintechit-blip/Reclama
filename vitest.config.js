import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests start an in-memory Postgres (WASM) or hash with argon2 (19 MiB each). On a machine
    // with dozens of cores the default of one worker per core starves them and tests time out, so
    // the number of workers is capped; 8 is plenty for this suite.
    maxWorkers: 8,
    testTimeout: 15_000,
  },
});
