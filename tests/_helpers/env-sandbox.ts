/**
 * `process.env` sandbox for tests.
 *
 * Why this exists: `process.env.X = '...'` followed by a manual restore
 * at the end of an `it()` is a foot-gun — any `expect()` that throws
 * between the set and the restore leaks the mutation into every later
 * test in the run. `dual-publish-warn.test.ts` hit exactly this trap with
 * `NODE_ENV` (the dual-publish detector, the error-handler's stack-trace
 * default, AND the mcpPlugin auth-disabled warn all branch on it — one
 * unrestored mutation cascades through unrelated suites).
 *
 * Two patterns:
 *
 *   1. `withEnv({ NODE_ENV: 'production' }, async () => { ... })` —
 *      scope mutations to one block; original values restored in a
 *      `finally` no matter how the block exits.
 *
 *   2. `installEnvSandbox()` inside `describe(...)` — registers a
 *      `beforeEach` snapshot + `afterEach` restore over the keys you
 *      name. Use when many tests in a file each need a different env
 *      and `withEnv` would clutter the bodies.
 *
 * Either pattern is leak-proof: throwing `expect()`s, async rejections,
 * and `vi.useFakeTimers()` boundaries all unwind through `finally`.
 */

import { afterEach, beforeEach } from "vitest";

type EnvPatch = Record<string, string | undefined>;

/**
 * Run `fn` with `patch` applied to `process.env`, restoring the original
 * values when it returns (or throws). `undefined` values delete the key.
 */
export async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T> | T): Promise<T> {
  const originals: EnvPatch = {};
  for (const key of Object.keys(patch)) {
    originals[key] = process.env[key];
    const next = patch[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      const orig = originals[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  }
}

/**
 * Register `beforeEach` snapshot + `afterEach` restore over the named
 * keys. Call inside a `describe(...)` block so the hooks scope to that
 * suite. Each test can freely mutate `process.env[key]` for any key in
 * `keys` — the snapshot taken in `beforeEach` is reapplied in
 * `afterEach`, guaranteed.
 */
export function installEnvSandbox(keys: readonly string[]): void {
  const snapshot: EnvPatch = {};
  beforeEach(() => {
    for (const key of keys) snapshot[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of keys) {
      const orig = snapshot[key];
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  });
}
