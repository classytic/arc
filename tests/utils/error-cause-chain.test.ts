/**
 * ArcError Cause Chain Tests
 *
 * Validates constructor behaviour with/without cause and nested cause chains.
 * (Wire-format serialization lives in the ErrorContract — correlationId +
 * flat ErrorDetail[] — and is covered by the error-contract tests; ArcError
 * itself no longer ships `toJSON()`.)
 */

import { afterEach, describe, expect, it } from "vitest";
import { ArcError, NotFoundError } from "../../src/utils/errors.js";

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  // No shared mutable state; hook present for pattern consistency.
});

// ============================================================================
// Constructor – cause handling
// ============================================================================

describe("ArcError cause chain", () => {
  it("should set cause via native Error when provided", () => {
    const root = new Error("root");
    const err = new ArcError("wrapper", { cause: root });

    expect(err.cause).toBe(root);
    expect(err.message).toBe("wrapper");
  });

  it("should work without a cause", () => {
    const err = new ArcError("standalone");

    expect(err.cause).toBeUndefined();
    expect(err.message).toBe("standalone");
    expect(err.code).toBe("arc.error");
    expect(err.statusCode).toBe(500);
  });

  it("should support a nested ArcError as cause", () => {
    const inner = new ArcError("inner", { code: "INNER" });
    const outer = new ArcError("outer", { cause: inner });

    expect(outer.cause).toBe(inner);
    expect((outer.cause as ArcError).code).toBe("INNER");
  });
});

// ============================================================================
// NotFoundError – cause chain via subclass
// ============================================================================

describe("NotFoundError cause chain", () => {
  it("should be an instance of ArcError", () => {
    const err = new NotFoundError("product", "123");

    expect(err).toBeInstanceOf(ArcError);
    expect(err.name).toBe("NotFoundError");
    expect(err.code).toBe("arc.not_found");
    expect(err.statusCode).toBe(404);
  });
});
