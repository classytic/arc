import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index.js";
import * as utils from "../../src/utils/index.js";

describe("resource validator public ownership", () => {
  it("exports resource validators from core only", () => {
    expect(typeof core.validateResourceConfig).toBe("function");
    expect(typeof core.assertValidConfig).toBe("function");
    expect(typeof core.formatValidationErrors).toBe("function");
    expect("validateResourceConfig" in utils).toBe(false);
    expect("assertValidConfig" in utils).toBe(false);
    expect("formatValidationErrors" in utils).toBe(false);
  });
});
