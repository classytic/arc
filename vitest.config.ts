import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/_helpers/load-env.ts"],
    exclude: [...configDefaults.exclude, "tests/perf/**"],
    // ── Parallelism strategy ──
    // Everything runs file-parallel EXCEPT the websocket suites, which share
    // real socket lifecycles and flake under a parallel pool. Encoding the
    // split as projects means plain `vitest run` is both fast and safe —
    // the old blanket `--no-file-parallelism` serialized all ~480 files to
    // protect ~10 (measured: parallel gives ~5x wall-clock on this suite;
    // isolation stays ON — each file re-evals its import graph, which is
    // the safety/speed tradeoff we keep).
    projects: [
      {
        extends: true,
        test: {
          name: "parallel",
          exclude: [...configDefaults.exclude, "tests/perf/**", "tests/integrations/websocket/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "ws-serial",
          include: ["tests/integrations/websocket/**/*.test.ts"],
          fileParallelism: false,
        },
      },
    ],
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
