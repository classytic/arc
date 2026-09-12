/**
 * `arcPlugins.gracefulShutdown` accepts `GracefulShutdownOptions` (2.41).
 *
 * `drainDelayMs` was unreachable from `createApp` while the option was a bare
 * boolean, so a factory-built app behind a load balancer had no lame-duck
 * window. Pinned here end-to-end through `createApp`: readiness fails first,
 * the app keeps serving, the server closes after the window.
 */

import { describe, expect, it } from "vitest";
import { arcApp } from "../_harness/index.js";

describe("createApp — arcPlugins.gracefulShutdown options", () => {
  it("`{ drainDelayMs }` reaches the plugin: /_health/ready fails first, the app still serves, then closes", async () => {
    const app = await arcApp({
      rateLimit: false,
      arcPlugins: { gracefulShutdown: { drainDelayMs: 50, signals: [], onForceExit: () => {} } },
    });
    let closedAt = 0;
    app.addHook("onClose", async () => {
      closedAt = Date.now();
    });

    expect((await app.inject({ method: "GET", url: "/_health/ready" })).statusCode).toBe(200);

    const started = Date.now();
    const shutdown = app.shutdown();

    const ready = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().status).toBe("draining");
    expect((await app.inject({ method: "GET", url: "/_health/live" })).statusCode).toBe(200);
    expect(closedAt).toBe(0);

    await shutdown;
    expect(closedAt - started).toBeGreaterThanOrEqual(50 - 10);
  });

  it("`true` (the default) still registers the plugin with defaults", async () => {
    const app = await arcApp({ rateLimit: false, arcPlugins: { gracefulShutdown: true } });
    expect(app.shutdownState).toEqual({ draining: false });
  });

  it("`false` still disables it", async () => {
    const app = await arcApp({ rateLimit: false, arcPlugins: { gracefulShutdown: false } });
    expect(app.hasDecorator("shutdownState")).toBe(false);
  });
});
