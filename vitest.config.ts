import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    env: { NODE_ENV: "test", OUTBOUND_ALLOW: "127.0.0.1,localhost" },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    maxWorkers: 6, // every file starts its own Postgres + Redis; unbounded parallelism starves the 300-job tests
  },
});
