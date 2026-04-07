import { afterEach, describe, expect, it, vi } from "vitest";
import { arcLog, configureArcLogger } from "../../src/logger/index.js";

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
