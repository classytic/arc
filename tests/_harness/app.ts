/**
 * `arcApp()` — the one way arc's own suite boots an app.
 *
 * 161 test files construct `Fastify({})` or `createApp({...})` by hand and 24
 * repeat the same four-line teardown. That is ~24k lines of scaffolding across
 * the suite, and it is why cross-cutting facts go untested: when every file
 * owns its own setup, nothing makes it cheap to assert the SAME fact twice.
 *
 * Two things earn this helper its place:
 *
 *   1. **Defaults measured from the suite, not invented.** `logger: false`
 *      appears in 218 call sites and `auth: false` in 213 — they are the case,
 *      not a case. Everything else passes straight through.
 *   2. **Teardown you cannot forget.** Apps register for automatic `close()`
 *      after each test. Hand-rolling means writing your own `afterEach`, so
 *      the lazy path is now the correct one — the reason `createTestApp`
 *      (8 adopters vs 161 hand-rolls) never caught on.
 *
 * DEV-ONLY. Not shipped: `src/testing/` is the public harness for HOSTS, and
 * `@classytic/arc-testkit` is the one for ecosystem packages. This file may
 * reach into `src/` internals; those two may not.
 */

import { afterEach } from "vitest";
import { createApp } from "../../src/factory/index.js";

type CreateAppOptions = Parameters<typeof createApp>[0];
export type ArcApp = Awaited<ReturnType<typeof createApp>>;

/** Apps created during the current test, closed when it ends. */
const live: ArcApp[] = [];

afterEach(async () => {
  // Reverse order: a co-resident app may share a store with an earlier one,
  // and closing newest-first matches how a process unwinds.
  for (const app of live.reverse()) {
    await app.close().catch(() => {
      /* teardown must not mask the assertion that already failed */
    });
  }
  live.length = 0;
});

/**
 * Boot an arc app with the suite's defaults, registered for auto-teardown.
 *
 * Pass any `createApp` option to override — including `logger`/`auth`, for the
 * handful of tests that are ABOUT logging or authentication.
 */
export async function arcApp(options: CreateAppOptions = {} as CreateAppOptions): Promise<ArcApp> {
  const app = await createApp({
    logger: false,
    auth: false,
    ...options,
  } as CreateAppOptions);
  live.push(app);
  return app;
}

/**
 * Assert that booting REFUSES, without leaking a half-booted app.
 *
 * A boot-fatal test that uses `arcApp()` directly would register nothing on
 * failure (the promise rejects before `push`), which is correct — but the
 * intent reads better named, and arc has a lot of boot-fatal contracts.
 */
export async function arcAppRefuses(options: CreateAppOptions, expected: RegExp): Promise<void> {
  const { expect } = await import("vitest");
  await expect(arcApp(options)).rejects.toThrow(expected);
}
