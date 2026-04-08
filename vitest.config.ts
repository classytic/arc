import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: [],
    exclude: [...configDefaults.exclude, "tests/perf/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
      exclude: [
        "node_modules/**",
        "dist/**",
        "tests/**",
        "**/*.d.ts",
        "**/*.config.*",
        "**/mockData",
      ],
    },
    testTimeout: 30000, // 30 seconds for E2E tests
    hookTimeout: 30000,
  },
});
