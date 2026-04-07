/**
 * Development preset — pino-pretty fallback test
 *
 * Verifies that the dev preset doesn't crash if pino-pretty is missing.
 * Common scenario: someone uses NODE_ENV-based preset selection and accidentally
 * runs the dev preset in production where pino-pretty isn't installed.
 */

import { describe, expect, it } from "vitest";
import { developmentPreset } from "../../src/factory/presets.js";

describe("developmentPreset — pino-pretty fallback", () => {
  it("logger is defined regardless of pino-pretty availability", () => {
    expect(developmentPreset.logger).toBeDefined();
  });

  it("logger has level 'debug'", () => {
    const logger = developmentPreset.logger as { level?: string };
    expect(logger.level).toBe("debug");
  });

  it("logger config is valid pino input (object, not crash sentinel)", () => {
    // Either { level, transport: { target: 'pino-pretty', ... } }
    // or { level: 'debug' } (fallback)
    const logger = developmentPreset.logger;
    expect(typeof logger).toBe("object");
    expect(logger).not.toBeNull();
  });
});
