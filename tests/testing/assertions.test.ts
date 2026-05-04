/**
 * expectArc — unit tests for the Arc-specific assertion helpers.
 *
 * The assertions themselves are thin wrappers over vitest `expect`, so the
 * cases below focus on: correct chaining, helpful error messages, and
 * paginated/meta envelope handling.
 *
 * No-envelope contract: HTTP status discriminates success vs error. Single-doc
 * responses are emitted raw at top level. Errors carry the canonical
 * `ErrorContract` (`{code, message, status, ...}`).
 */

import { describe, expect, it } from "vitest";
import { expectArc } from "../../src/testing/assertions.js";

function res(statusCode: number, body: unknown) {
  return { statusCode, body: typeof body === "string" ? body : JSON.stringify(body) };
}

describe("expectArc.ok()", () => {
  it("passes on 200 with raw payload", () => {
    expectArc(res(200, { id: 1 })).ok();
  });

  it("accepts a custom success status (e.g. 201 on create)", () => {
    expectArc(res(201, { id: 1 })).ok(201);
  });

  it("fails when statusCode is not 2xx", () => {
    expect(() => expectArc(res(500, { code: "arc.internal_error", message: "x" })).ok()).toThrow();
  });
});

describe("expectArc.failed / unauthorized / forbidden / notFound / validationError / conflict", () => {
  it("unauthorized → 401 + ErrorContract.code", () => {
    expectArc(res(401, { code: "arc.unauthorized", message: "no token" })).unauthorized();
  });

  it("forbidden → 403 + ErrorContract.code", () => {
    expectArc(res(403, { code: "arc.forbidden", message: "denied" })).forbidden();
  });

  it("notFound → 404", () => {
    expectArc(res(404, { code: "arc.not_found", message: "missing" })).notFound();
  });

  it("validationError → 400", () => {
    expectArc(res(400, { code: "arc.validation_error", message: "bad" })).validationError();
  });

  it("conflict → 409", () => {
    expectArc(res(409, { code: "arc.conflict", message: "dup" })).conflict();
  });

  it("failed() without status asserts only >= 400 + ErrorContract.code", () => {
    expectArc(res(422, { code: "arc.validation_error", message: "x" })).failed();
  });
});

describe("expectArc.hidesField / showsField", () => {
  it("hidesField passes when the field is absent from raw body", () => {
    expectArc(res(200, { id: 1, name: "x" })).hidesField("password");
  });

  it("hidesField fails when the field IS present", () => {
    expect(() => expectArc(res(200, { id: 1, password: "hash" })).hidesField("password")).toThrow();
  });

  it("showsField passes when the field is present", () => {
    expectArc(res(200, { id: 1, name: "x" })).showsField("name");
  });

  it("showsField fails when absent", () => {
    expect(() => expectArc(res(200, { id: 1 })).showsField("name")).toThrow();
  });
});

describe("expectArc.paginated", () => {
  it("passes when body has data[] and pagination meta (offset method)", () => {
    expectArc(
      res(200, {
        method: "offset",
        data: [{ id: 1 }],
        page: 1,
        limit: 20,
        total: 1,
        hasNext: false,
        hasPrev: false,
      }),
    ).paginated({ page: 1, limit: 20, total: 1, hasNext: false, hasPrev: false });
  });

  it("accepts a bare data-array shape (non-paginated list)", () => {
    expectArc(res(200, { data: [{ id: 1 }] })).paginated();
  });

  it("fails when data is not an array", () => {
    expect(() => expectArc(res(200, { data: { id: 1 } })).paginated()).toThrow();
  });
});

describe("expectArc.hasError / hasMeta", () => {
  it("hasError matches a string message field", () => {
    expectArc(res(403, { code: "arc.forbidden", message: "Permission denied" })).hasError(
      "Permission denied",
    );
  });

  it("hasError matches a regex against body.message", () => {
    expectArc(res(400, { code: "arc.validation_error", message: "Invalid action 'x'" })).hasError(
      /Invalid action/,
    );
  });

  it("hasError accepts body.message for canonical ErrorContract", () => {
    expectArc(res(500, { code: "arc.internal_error", message: "Internal error" })).hasError(
      /Internal/,
    );
  });

  it("hasMeta reads the flattened top-level shape that sendControllerResponse emits", () => {
    // sendControllerResponse spreads `meta` into top-level fields, so `validActions`
    // lands at body.validActions, NOT body.meta.validActions.
    expectArc(
      res(400, { code: "arc.validation_error", message: "x", validActions: ["a", "b"] }),
    ).hasMeta("validActions", ["a", "b"]);
  });

  it("hasMeta falls back to nested body.meta when flattening isn't in play", () => {
    expectArc(res(200, { id: 1, meta: { traceId: "t1" } })).hasMeta("traceId", "t1");
  });
});

describe("expectArc accessors + chaining", () => {
  it("body and data memoize — repeated access does not re-parse", () => {
    const response = res(200, { data: [{ id: 1 }] });
    const a = expectArc(response);
    // Two accesses should return the same parsed reference
    expect(a.body).toBe(a.body);
    expect(a.data).toEqual([{ id: 1 }]);
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
    const a = expectArc(res(200, { id: 1, name: "x" }));
    const returned = a.ok().hasData().hidesField("password").showsField("id");
    expect(returned).toBe(a);
  });
});
