import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: [],
    include: ["tests/perf/**/*.test.ts"],
    fileParallelism: false,
    isolate: true,
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
