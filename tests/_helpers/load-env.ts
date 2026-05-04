/**
 * Vitest global setup — load `.env` before any test module evaluates.
 *
 * Used as `setupFiles` in `vitest.config.ts` / `vitest.perf.config.ts`
 * so that environmentally-gated suites (Upstash Redis, OpenTelemetry,
 * better-auth real-flow tests) see their credentials when developers
 * keep them in a local `.env` instead of exporting them in their shell.
 *
 * Uses Node 22's built-in `process.loadEnvFile()` — zero deps. CI runners
 * without a `.env` (vars injected via secrets) silently no-op.
 *
 * Existing `process.env` values WIN over `.env` entries (Node's
 * `loadEnvFile` semantics), so CI / shell exports always override the
 * checked-in defaults.
 */

try {
  process.loadEnvFile(".env");
} catch (err: unknown) {
  // ENOENT (file missing) is the common case in CI — silent no-op.
  // Anything else (parse error, permission denied) deserves a one-line
  // diagnostic so misconfigured local setups surface loudly.
  if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
    // biome-ignore lint/suspicious/noConsole: setup-file diagnostic
    console.warn(`[vitest setup] process.loadEnvFile(".env") failed:`, err);
  }
}
