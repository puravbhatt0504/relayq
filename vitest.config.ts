import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { NODE_ENV: "test" }, testTimeout: 30_000, hookTimeout: 120_000 } });
