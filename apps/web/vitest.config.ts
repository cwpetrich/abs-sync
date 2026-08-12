import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // One SQLite file is shared across the suite, so files must not race.
    fileParallelism: false,
    // The transfer worker uses node:fs and native better-sqlite3; forks keep
    // those from leaking between test files.
    pool: 'forks',
    // node-upload.test.ts asserts that a streamed upload does not accumulate in
    // memory, which needs a collection it can trust rather than whatever the GC
    // happened to do during a 400ms test.
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
