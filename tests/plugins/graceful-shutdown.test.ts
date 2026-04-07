import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gracefulShutdownPlugin } from "../../src/plugins/gracefulShutdown.js";

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
