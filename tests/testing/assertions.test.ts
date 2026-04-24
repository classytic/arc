/**
 * expectArc — unit tests for the Arc-specific assertion helpers.
 *
 * The assertions themselves are thin wrappers over vitest `expect`, so the
 * cases below focus on: correct chaining, helpful error messages, and
 * paginated/meta envelope handling.
 */

import { describe, expect, it } from "vitest";
import { expectArc } from "../../src/testing/assertions.js";

function res(statusCode: number, body: unknown) {
  return { statusCode, body: typeof body === "string" ? body : JSON.stringify(body) };
}

describe("expectArc.ok()", () => {
  it("passes on 200 + success: true", () => {
    expectArc(res(200, { success: true, data: { id: 1 } })).ok();
  });

  it("accepts a custom success status (e.g. 201 on create)", () => {
    expectArc(res(201, { success: true, data: {} })).ok(201);
  });

  it("fails when statusCode is not 2xx", () => {
    expect(() => expectArc(res(500, { success: true })).ok()).toThrow();
  });

  it("fails when body.success is false even on 200", () => {
    expect(() => expectArc(res(200, { success: false })).ok()).toThrow();
  });
});

describe("expectArc.failed / unauthorized / forbidden / notFound / validationError / conflict", () => {
  it("unauthorized → 401 + success: false", () => {
    expectArc(res(401, { success: false, error: "no token" })).unauthorized();
  });

  it("forbidden → 403 + success: false", () => {
    expectArc(res(403, { success: false })).forbidden();
  });

  it("notFound → 404", () => {
    expectArc(res(404, { success: false })).notFound();
  });

  it("validationError → 400", () => {
    expectArc(res(400, { success: false })).validationError();
  });

  it("conflict → 409", () => {
    expectArc(res(409, { success: false })).conflict();
  });

  it("failed() without status asserts only >= 400 + success: false", () => {
    expectArc(res(422, { success: false })).failed();
  });
});

describe("expectArc.hidesField / showsField", () => {
  it("hidesField passes when the field is absent from body.data", () => {
    expectArc(res(200, { success: true, data: { id: 1, name: "x" } })).hidesField("password");
  });

  it("hidesField fails when the field IS present", () => {
    expect(() =>
      expectArc(res(200, { success: true, data: { id: 1, password: "hash" } })).hidesField(
        "password",
      ),
    ).toThrow();
  });

  it("showsField passes when the field is present", () => {
    expectArc(res(200, { success: true, data: { id: 1, name: "x" } })).showsField("name");
  });

  it("showsField fails when absent", () => {
    expect(() =>
      expectArc(res(200, { success: true, data: { id: 1 } })).showsField("name"),
    ).toThrow();
  });
});

describe("expectArc.paginated", () => {
  it("passes when body has success + docs[] (arc's flattened paginated envelope)", () => {
    expectArc(
      res(200, {
        success: true,
        docs: [{ id: 1 }],
        page: 1,
        limit: 20,
        total: 1,
        hasNext: false,
        hasPrev: false,
      }),
    ).paginated({ page: 1, limit: 20, total: 1, hasNext: false, hasPrev: false });
  });

  it("accepts an array-under-data fallback shape", () => {
    expectArc(res(200, { success: true, data: [{ id: 1 }] })).paginated();
  });

  it("fails when neither docs nor data-array is present", () => {
    expect(() => expectArc(res(200, { success: true, data: { id: 1 } })).paginated()).toThrow();
  });
});

describe("expectArc.hasError / hasMeta", () => {
  it("hasError matches a string error field", () => {
    expectArc(res(403, { success: false, error: "Permission denied" })).hasError(
      "Permission denied",
    );
  });

  it("hasError matches a regex against body.error", () => {
    expectArc(res(400, { success: false, error: "Invalid action 'x'" })).hasError(/Invalid action/);
  });

  it("hasError also accepts body.message for non-arc standard errors", () => {
    expectArc(res(500, { success: false, message: "Internal error" })).hasError(/Internal/);
  });

  it("hasMeta reads the flattened top-level shape that sendControllerResponse emits", () => {
    // sendControllerResponse spreads `meta` into top-level fields, so `validActions`
    // lands at body.validActions, NOT body.meta.validActions.
    expectArc(res(400, { success: false, error: "x", validActions: ["a", "b"] })).hasMeta(
      "validActions",
      ["a", "b"],
    );
  });

  it("hasMeta falls back to nested body.meta when flattening isn't in play", () => {
    expectArc(res(200, { success: true, meta: { traceId: "t1" } })).hasMeta("traceId", "t1");
  });
});

describe("expectArc accessors + chaining", () => {
  it("body and data memoize — repeated access does not re-parse", () => {
    const response = res(200, { success: true, data: { id: 1 } });
    const a = expectArc(response);
    // Two accesses should return the same parsed reference
    expect(a.body).toBe(a.body);
    expect(a.data).toEqual({ id: 1 });
  });

  it("throws a clear diagnostic on non-JSON bodies when body/data is accessed", () => {
    // Status-check assertions short-circuit before body parsing, so we
    // trigger parsing via the `.body` accessor directly.
    const a = expectArc({ statusCode: 200, body: "<html>boom</html>" });
    expect(() => a.body).toThrow(/response body is not valid JSON/);
    expect(() => a.data).toThrow(/response body is not valid JSON/);
    // Chained helpers that read body (hasData) also surface the parse error
    expect(() => a.hasData()).toThrow(/response body is not valid JSON/);
  });

  it("chains correctly — every helper returns the same assertion object", () => {
    const a = expectArc(res(200, { success: true, data: { id: 1, name: "x" } }));
    const returned = a.ok().hasData().hidesField("password").showsField("id");
    expect(returned).toBe(a);
  });
});
