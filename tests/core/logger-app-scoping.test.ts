/**
 * Two apps in ONE process keep their own `arcLog` writer.
 *
 * `configureArcLogger` wrote to module-level state and `createApp` called it
 * on every boot, so the LAST app constructed owned the writer for every app
 * in the process. App A's framework warnings then surfaced through app B's
 * pino instance — B's transports, B's level, B's redaction. One-app-per-
 * process never noticed; multi-app test files and warm serverless containers
 * that reuse a process across apps did.
 *
 * The fix scopes the options per app via `AsyncLocalStorage` (the same shape
 * `requestContext` uses) and demotes the process global to a fallback for
 * code running outside any app — `defineResource()` at module import, CLI
 * commands, standalone helpers.
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/factory/index.js";
import {
  arcLog,
  configureArcLogger,
  createPinoWriter,
  runWithArcLogger,
} from "../../src/logger/index.js";

const live: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  for (const app of live.reverse()) await app.close().catch(() => {});
  live.length = 0;
  // Reset the process fallback so one test's global cannot leak into another.
  configureArcLogger({});
});

/**
 * Spy on an app's OWN pino instance after boot.
 *
 * `createPinoWriter(fastify.log)` captures the log object by reference and
 * resolves the level method at emit time, so replacing `warn` on the instance
 * intercepts exactly what arc routes there. Passing a fake logger to
 * `createApp` instead is not an option — Fastify 5 validates `logger` as a
 * config object and takes instances only via `loggerInstance`.
 */
function spyOnWarn(app: { log: Record<string, unknown> }) {
  const warn = vi.fn();
  Object.assign(app.log, { warn });
  return warn;
}

const said = (warn: ReturnType<typeof vi.fn>, text: string) =>
  warn.mock.calls.some((c) => JSON.stringify(c).includes(text));

/**
 * A bare pino-shaped sink for the STANDALONE cases below, which never hand
 * this to Fastify and so are not subject to its logger validation.
 */
function aLogger() {
  const warn = vi.fn();
  return { warn, logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } };
}

describe("arcLog is scoped per app", () => {
  it("a warning inside app A does not reach app B's logger", async () => {
    const appA = await createApp({ auth: false, logger: { level: "silent" } });
    const appB = await createApp({ auth: false, logger: { level: "silent" } });
    live.push(appA, appB);
    const warnA = spyOnWarn(appA as never);
    const warnB = spyOnWarn(appB as never);

    // Raise the warning through each app's REQUEST lifecycle — the path a
    // framework warning actually takes.
    appA.get("/warn", async () => {
      arcLog("test-scope").warn("from A");
      return { ok: true };
    });
    appB.get("/warn", async () => {
      arcLog("test-scope").warn("from B");
      return { ok: true };
    });
    await appA.inject({ method: "GET", url: "/warn" });
    await appB.inject({ method: "GET", url: "/warn" });

    expect(said(warnA, "from A")).toBe(true);
    expect(said(warnB, "from B")).toBe(true);
    // The actual regression: before scoping, the last-booted app owned the
    // writer, so BOTH warnings landed on B and A saw nothing.
    expect(said(warnB, "from A")).toBe(false);
    expect(said(warnA, "from B")).toBe(false);
  });

  it("booting a SECOND app does not steal the first app's writer", async () => {
    const appA = await createApp({ auth: false, logger: { level: "silent" } });
    live.push(appA);
    const warnA = spyOnWarn(appA as never);

    // Boot a second app AFTER A is live — the exact sequence that used to
    // repoint the process-global writer at B.
    const appB = await createApp({ auth: false, logger: { level: "silent" } });
    live.push(appB);

    appA.get("/warn", async () => {
      arcLog("test-scope").warn("still-mine");
      return { ok: true };
    });
    await appA.inject({ method: "GET", url: "/warn" });

    expect(said(warnA, "still-mine")).toBe(true);
  });

  it("outside any app, the process-global writer is still used", async () => {
    // The fallback is the whole reason `configureArcLogger` still exists:
    // `defineResource()` runs at module import, before any app exists.
    const sink = aLogger();
    configureArcLogger({ writer: createPinoWriter(sink.logger) });

    arcLog("test-scope").warn("standalone");

    expect(sink.warn).toHaveBeenCalled();
    expect(JSON.stringify(sink.warn.mock.calls)).toContain("standalone");
  });

  it("an explicit scope wins over the process global", async () => {
    const global = aLogger();
    const scoped = aLogger();
    configureArcLogger({ writer: createPinoWriter(global.logger) });

    runWithArcLogger({ writer: createPinoWriter(scoped.logger) }, () => {
      arcLog("test-scope").warn("scoped");
    });

    expect(JSON.stringify(scoped.warn.mock.calls)).toContain("scoped");
    expect(global.warn).not.toHaveBeenCalled();
  });

  it("a bare Fastify app (no createApp) leaves the global fallback intact", async () => {
    // Guards against the scope leaking: entering it must not be sticky.
    const sink = aLogger();
    configureArcLogger({ writer: createPinoWriter(sink.logger) });

    const bare = Fastify({ logger: false });
    await bare.ready();
    arcLog("test-scope").warn("still-global");
    await bare.close();

    expect(JSON.stringify(sink.warn.mock.calls)).toContain("still-global");
  });
});
