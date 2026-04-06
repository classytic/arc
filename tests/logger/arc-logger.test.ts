import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { arcLog, configureArcLogger } from "../../src/logger/index.js";

describe("arcLog()", () => {
  it("creates a module-scoped logger", () => {
    const log = arcLog("test-module");
    expect(log).toBeDefined();
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("different modules get different logger instances", () => {
    const log1 = arcLog("module-a");
    const log2 = arcLog("module-b");
    // They should be separate instances
    expect(log1).not.toBe(log2);
  });
});

describe("configureArcLogger()", () => {
  afterEach(() => {
    // Reset to defaults
    configureArcLogger({});
  });

  it("accepts custom writer", () => {
    const writer = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    configureArcLogger({ writer });
    const log = arcLog("custom");
    log.info("test message");
    expect(writer.info).toHaveBeenCalled();
  });

  it("respects debug flag", () => {
    const writer = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    configureArcLogger({ debug: true, writer });
    const log = arcLog("debug-test");
    log.debug("debug message");
    expect(writer.debug).toHaveBeenCalled();
  });

  it("suppresses debug by default", () => {
    const writer = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    configureArcLogger({ debug: false, writer });
    const log = arcLog("no-debug");
    log.debug("should not appear");
    expect(writer.debug).not.toHaveBeenCalled();
  });
});
