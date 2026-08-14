import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          // Real Ghost round-trips (image upload + 15 posts) are slow.
          testTimeout: 180_000,
          hookTimeout: 180_000,
          // E2E mutates one shared Ghost instance; parallel files would
          // race on the #themeseed tag and post counts.
          fileParallelism: false,
        },
      },
    ],
  },
});
