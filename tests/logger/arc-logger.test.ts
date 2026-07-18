import { afterEach, describe, expect, it, vi } from "vitest";
import { arcLog, configureArcLogger, createPinoWriter } from "../../src/logger/index.js";

describe("arcLog()", () => {
  afterEach(() => {
    configureArcLogger({});
  });

  it("creates a module-scoped logger with debug/info/warn/error", () => {
    const log = arcLog("test-module");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("error always writes regardless of debug setting", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ writer });
    const log = arcLog("mod");
    log.error("something broke");
    expect(writer.error).toHaveBeenCalled();
  });

  it("warn writes unless suppressed", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ writer });
    const log = arcLog("mod");
    log.warn("warning");
    expect(writer.warn).toHaveBeenCalled();
  });

  it("debug is gated — silent when debug is off", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ debug: false, writer });
    const log = arcLog("mod");
    log.debug("should not appear");
    expect(writer.debug).not.toHaveBeenCalled();
  });

  it("debug writes when debug: true", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ debug: true, writer });
    const log = arcLog("mod");
    log.debug("should appear");
    expect(writer.debug).toHaveBeenCalled();
  });

  it("info is gated by debug setting (same as debug)", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ debug: true, writer });
    const log = arcLog("mod");
    log.info("info message");
    expect(writer.info).toHaveBeenCalled();
  });

  it("info is silent when debug is off", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ debug: false, writer });
    const log = arcLog("mod");
    log.info("should not appear");
    expect(writer.info).not.toHaveBeenCalled();
  });

  it("supports module-specific debug filter", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ debug: "scope,elevation", writer });

    const scopeLog = arcLog("scope");
    const otherLog = arcLog("other");

    scopeLog.debug("visible");
    otherLog.debug("hidden");

    expect(writer.debug).toHaveBeenCalledTimes(1);
    expect(writer.debug).toHaveBeenCalledWith("[arc:scope]", "visible");
  });

  it("prefixes messages with [arc:module]", () => {
    const writer = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureArcLogger({ writer });
    const log = arcLog("auth");
    log.error("fail");
    expect(writer.error).toHaveBeenCalledWith("[arc:auth]", "fail");
  });
});

describe("createPinoWriter()", () => {
  afterEach(() => {
    configureArcLogger({});
  });

  function makePino() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it("folds string args into a single pino message", () => {
    const pino = makePino();
    configureArcLogger({ writer: createPinoWriter(pino) });
    arcLog("mod").warn("first part", "second part");
    expect(pino.warn).toHaveBeenCalledWith("[arc:mod] first part second part");
  });

  it("merges object args into the pino merge object — console-style args survive", () => {
    const pino = makePino();
    configureArcLogger({ writer: createPinoWriter(pino) });
    arcLog("scope").warn("elevation applied", { userId: "u1", orgId: "o1" });
    expect(pino.warn).toHaveBeenCalledWith(
      { userId: "u1", orgId: "o1" },
      "[arc:scope] elevation applied",
    );
  });

  it("maps Error args to { err } so pino's error serializer applies", () => {
    const pino = makePino();
    configureArcLogger({ writer: createPinoWriter(pino) });
    const boom = new Error("boom");
    arcLog("mod").error("handler threw", boom);
    expect(pino.error).toHaveBeenCalledWith({ err: boom }, "[arc:mod] handler threw");
  });

  it("stringifies primitive non-string args into the message", () => {
    const pino = makePino();
    configureArcLogger({ writer: createPinoWriter(pino) });
    arcLog("mod").error("retries:", 3);
    expect(pino.error).toHaveBeenCalledWith("[arc:mod] retries: 3");
  });
});

describe("createApp wires arcLog into fastify.log", () => {
  afterEach(() => {
    configureArcLogger({});
  });

  it("routes arcLog output through the app's pino logger", async () => {
    const lines: string[] = [];
    const { createApp } = await import("../../src/factory/createApp.js");
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: { level: "warn", stream: { write: (s: string) => void lines.push(s) } } as never,
    });
    try {
      arcLog("wiring-test").warn("through pino", { marker: "xyz" });
      const hit = lines.find((l) => l.includes("[arc:wiring-test] through pino"));
      expect(hit).toBeDefined();
      expect(JSON.parse(hit as string).marker).toBe("xyz");
    } finally {
      await app.close();
    }
  });

  it("keeps the console fallback when logger: false", async () => {
    const { createApp } = await import("../../src/factory/createApp.js");
    // Reset any writer installed by earlier apps in this file.
    configureArcLogger({});
    const app = await createApp({ preset: "testing", auth: false, logger: false });
    try {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      arcLog("fallback-test").warn("still visible");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      await app.close();
    }
  });
});
