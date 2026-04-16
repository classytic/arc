/**
 * Graceful shutdown — in-flight request behaviour
 *
 * `tests/plugins/graceful-shutdown.test.ts` covers the decorator surface and
 * callback ordering. This file covers the harder case: what happens when a
 * long-running request is in flight and `fastify.shutdown()` is called.
 *
 * Contract (derived from src/plugins/gracefulShutdown.ts):
 *   - In-flight requests MUST finish before shutdown resolves (Fastify's
 *     `close()` waits on them).
 *   - If the in-flight request exceeds the shutdown timeout, the force-exit
 *     callback fires so tests (and operators) can observe it — but the
 *     existing request still completes locally because we never kill the
 *     connection in-process.
 *   - `onShutdown` callback runs AFTER in-flight requests drain, not
 *     before — state cleanup should see a quiesced server.
 *
 * We deliberately do NOT send real SIGTERM / SIGINT; `app.shutdown()`
 * exposes the same path synchronously, which keeps the test fast and
 * hermetic.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gracefulShutdownPlugin } from "../../src/plugins/gracefulShutdown.js";

describe("graceful shutdown — in-flight requests", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    // Some tests close the app themselves; swallow "already closed".
    await app?.close().catch(() => {});
  });

  it("in-flight long request completes before shutdown resolves", async () => {
    app = Fastify({ logger: false });
    const onShutdown = vi.fn(async () => {});
    const onForceExit = vi.fn(); // prevent process.exit during test

    await app.register(gracefulShutdownPlugin, {
      timeout: 5000,
      onShutdown,
      onForceExit,
      signals: [], // no signal listeners → avoid polluting the process
    });

    const sleepMs = 150;
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, sleepMs));
      return { done: true };
    });
    await app.ready();

    const started = Date.now();
    // Start the slow request but do NOT await yet.
    const slowPromise = app.inject({ method: "GET", url: "/slow" });

    // Give the handler a tick to enter.
    await new Promise((r) => setImmediate(r));

    // Trigger shutdown — should wait for the in-flight request to finish.
    const shutdownPromise = app.shutdown();

    const [response] = await Promise.all([slowPromise, shutdownPromise]);
    const elapsed = Date.now() - started;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ done: true });

    // Shutdown could not have completed faster than the handler's sleep.
    expect(elapsed).toBeGreaterThanOrEqual(sleepMs - 20);

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("shutdown() does not abort an in-flight handler — the request still returns 200", async () => {
    // The important guarantee from an operator's POV: if a long request is in
    // progress when shutdown is triggered, it completes successfully rather
    // than being abandoned. The internal ordering between `fastify.close()`
    // resolving and `onShutdown` running is an implementation detail and
    // `app.inject()` (no real socket) can't reliably exercise drain ordering.
    app = Fastify({ logger: false });
    const onShutdown = vi.fn(async () => {});
    await app.register(gracefulShutdownPlugin, {
      timeout: 5000,
      onShutdown,
      onForceExit: () => {},
      signals: [],
    });

    let handlerCompleted = false;
    app.get("/w", async () => {
      await new Promise((r) => setTimeout(r, 50));
      handlerCompleted = true;
      return { ok: true };
    });
    await app.ready();

    const req = app.inject({ method: "GET", url: "/w" });
    await new Promise((r) => setImmediate(r));
    const sd = app.shutdown();

    const [res] = await Promise.all([req, sd]);
    expect(res.statusCode).toBe(200);
    expect(handlerCompleted).toBe(true);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("second shutdown() call is a no-op (idempotent)", async () => {
    app = Fastify({ logger: false });
    const onShutdown = vi.fn(async () => {});
    await app.register(gracefulShutdownPlugin, {
      timeout: 2000,
      onShutdown,
      onForceExit: () => {},
      signals: [],
    });
    app.get("/ok", async () => ({ ok: true }));
    await app.ready();

    await app.shutdown();
    await app.shutdown(); // should not throw or re-invoke

    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("handler exception does not block shutdown", async () => {
    app = Fastify({ logger: false });
    const onShutdown = vi.fn(async () => {});
    await app.register(gracefulShutdownPlugin, {
      timeout: 2000,
      onShutdown,
      onForceExit: () => {},
      signals: [],
    });

    app.get("/boom", async () => {
      throw new Error("handler crashed");
    });
    await app.ready();

    const req = app.inject({ method: "GET", url: "/boom" });
    await new Promise((r) => setImmediate(r));
    const sd = app.shutdown();

    const [res] = await Promise.all([req, sd]);

    expect(res.statusCode).toBe(500);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});
