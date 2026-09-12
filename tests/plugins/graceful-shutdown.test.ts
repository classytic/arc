import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gracefulShutdownPlugin } from "../../src/plugins/gracefulShutdown.js";
import healthPlugin from "../../src/plugins/health.js";

describe("gracefulShutdownPlugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {
      // Already closed
    }
  });

  it("registers shutdown decorator on fastify", async () => {
    app = Fastify();
    await app.register(gracefulShutdownPlugin, {
      onForceExit: () => {},
      logEvents: false,
    });
    await app.ready();
    expect(typeof app.shutdown).toBe("function");
  });

  it("calls onShutdown during manual shutdown", async () => {
    const onShutdown = vi.fn();
    app = Fastify();
    await app.register(gracefulShutdownPlugin, {
      onShutdown,
      onForceExit: () => {},
      logEvents: false,
    });
    await app.ready();

    await app.shutdown();
    expect(onShutdown).toHaveBeenCalledOnce();
  });

  it("calls onForceExit with 'error' when onShutdown throws", async () => {
    const onForceExit = vi.fn();
    app = Fastify();
    await app.register(gracefulShutdownPlugin, {
      onShutdown: async () => {
        throw new Error("cleanup failed");
      },
      onForceExit,
      logEvents: false,
    });
    await app.ready();

    await app.shutdown();
    expect(onForceExit).toHaveBeenCalledWith("error");
  });

  it("removes signal handlers on close", async () => {
    const removeSpy = vi.spyOn(process, "removeListener");
    app = Fastify();
    await app.register(gracefulShutdownPlugin, {
      signals: ["SIGTERM"],
      onForceExit: () => {},
      logEvents: false,
    });
    await app.ready();
    await app.close();

    expect(removeSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    removeSpy.mockRestore();
  });

  it("prevents double shutdown", async () => {
    const onShutdown = vi.fn();
    app = Fastify();
    await app.register(gracefulShutdownPlugin, {
      onShutdown,
      onForceExit: () => {},
      logEvents: false,
    });
    await app.ready();

    // First call triggers shutdown
    await app.shutdown();
    // Second call is ignored (already shutting down)
    await app.shutdown();
    expect(onShutdown).toHaveBeenCalledOnce();
  });

  it("defaults to SIGTERM and SIGINT signals", async () => {
    const onSpy = vi.spyOn(process, "on");
    app = Fastify();
    await app.register(gracefulShutdownPlugin, {
      onForceExit: () => {},
      logEvents: false,
    });
    await app.ready();

    const signalCalls = onSpy.mock.calls.filter(
      ([event]) => event === "SIGTERM" || event === "SIGINT",
    );
    expect(signalCalls.length).toBeGreaterThanOrEqual(2);
    onSpy.mockRestore();
    await app.close();
  });
});

/**
 * Lame duck: readiness must fail BEFORE the server stops accepting, or the
 * load balancer keeps routing to a closed instance for 2–3 probe intervals
 * (the rolling-deploy 502). Health is registered FIRST, as the factory does,
 * so this also pins that `/ready` reads the drain state at request time.
 */
describe("gracefulShutdownPlugin — lame duck (drainDelayMs)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function drainingApp(drainDelayMs: number): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    await instance.register(healthPlugin);
    await instance.register(gracefulShutdownPlugin, {
      drainDelayMs,
      signals: [],
      onForceExit: () => {},
      logEvents: false,
    });
    instance.get("/ok", async () => ({ ok: true }));
    await instance.ready();
    return instance;
  }

  it("/ready is 200 before the signal and 503 `draining` after — /live stays 200", async () => {
    app = await drainingApp(300);

    expect((await app.inject({ method: "GET", url: "/_health/ready" })).statusCode).toBe(200);
    expect(app.shutdownState.draining).toBe(false);

    const shutdown = app.shutdown();

    const ready = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "draining", checks: [] });

    // Alive is not the same as ready — a draining process is alive.
    expect((await app.inject({ method: "GET", url: "/_health/live" })).statusCode).toBe(200);
    expect(app.shutdownState.draining).toBe(true);
    expect(app.shutdownState.since).toBeInstanceOf(Date);

    await shutdown;
  });

  it("keeps answering requests for the drain window, then closes", async () => {
    app = await drainingApp(50);
    let closedAt = 0;
    app.addHook("onClose", async () => {
      closedAt = Date.now();
    });

    const started = Date.now();
    const shutdown = app.shutdown();

    // In the window: normal traffic is served, only readiness says no.
    const ok = await app.inject({ method: "GET", url: "/ok" });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/_health/ready" })).statusCode).toBe(503);
    expect(closedAt).toBe(0);

    await shutdown;
    expect(closedAt).toBeGreaterThan(0);
    expect(closedAt - started).toBeGreaterThanOrEqual(50 - 10);
  });

  it("default drainDelayMs is 0 — the pre-2.41 behaviour (close immediately)", async () => {
    app = Fastify({ logger: false });
    await app.register(gracefulShutdownPlugin, {
      signals: [],
      onForceExit: () => {},
      logEvents: false,
    });
    await app.ready();

    const started = Date.now();
    await app.shutdown();
    expect(Date.now() - started).toBeLessThan(40);
    expect(app.shutdownState.draining).toBe(true);
  });
});
