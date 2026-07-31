import { configDefaults, defineConfig } from "vitest/config";

/**
 * Suites whose assertions are wall-clock dependent — "N ticks in M ms", a
 * heartbeat arriving, a lease renewing. They run serialized; everything else
 * runs file-parallel.
 */
const TIMING_SENSITIVE = [
  "tests/integrations/websocket/**/*.test.ts",
  "tests/plugins/schedules.test.ts",
  "tests/plugins/sse.test.ts",
  "tests/plugins/realtime.test.ts",
  // Everything below asserts "an async side effect landed within N ms" — bridged
  // audit rows, emitted events, webhook deliveries. Selected by sleep density
  // (>=6 `await sleep()` per file), not one at a time as each flaked: they share
  // one failure mode, so they share one fix.
  //
  // A file LEAVES this list by converting its waits to `waitFor(...)` /
  // `fetchSSE(..., until)` — a condition-based wait cannot be starved by the
  // pool, so it no longer needs the pool constrained. `streamline.test.ts` came
  // off that way.
  "tests/integrations/webhooks.test.ts",
  "tests/auth/audit-bridge.test.ts",
  "tests/audit/auto-audit.test.ts",
  "tests/audit/audit-per-resource.test.ts",
  "tests/core/event-emission.test.ts",
];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/_helpers/load-env.ts"],
    exclude: [...configDefaults.exclude, "tests/perf/**"],
    // ── Parallelism strategy ──
    // Everything runs file-parallel EXCEPT suites whose assertions depend on
    // WALL CLOCK: websockets (real socket lifecycles) and timer-driven plugins
    // (schedules, SSE heartbeats, realtime leases). Those assert "N events
    // happened within M ms", which a saturated pool starves — the failure then
    // lands on a different file each run and reads as a product bug rather than
    // scheduling pressure. Encoding the split as projects keeps plain
    // `vitest run` both fast and safe: the old blanket `--no-file-parallelism`
    // serialized all ~480 files to protect ~12 (measured: parallel gives ~5x
    // wall-clock on this suite; isolation stays ON — each file re-evals its
    // import graph, which is the safety/speed tradeoff we keep).
    //
    // Widen `TIMING_SENSITIVE` rather than padding another sleep: a test that
    // needs a bigger margin to survive the pool is being starved, not slow.
    projects: [
      {
        extends: true,
        test: {
          name: "parallel",
          exclude: [...configDefaults.exclude, "tests/perf/**", ...TIMING_SENSITIVE],
        },
      },
      {
        extends: true,
        test: {
          name: "timing-serial",
          include: [...TIMING_SENSITIVE],
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
