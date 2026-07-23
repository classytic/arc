import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/utils/errors.js";
import { getHeader, requireSingleHeaderValue } from "../../src/utils/headers.js";

describe("header accessors", () => {
  it("keeps first-value semantics for ordinary repeated headers", () => {
    expect(getHeader({ accept: ["application/json", "text/plain"] }, "Accept")).toBe(
      "application/json",
    );
  });

  it("reads a single security-sensitive header case-insensitively", () => {
    expect(requireSingleHeaderValue({ "x-organization-id": "org-1" }, "X-Organization-Id")).toBe(
      "org-1",
    );
  });

  it("rejects repeated security-sensitive headers", () => {
    expect(() =>
      requireSingleHeaderValue({ "x-organization-id": ["org-1", "org-2"] }, "x-organization-id"),
    ).toThrow(new ValidationError("Duplicate 'x-organization-id' header"));
  });

  it("returns undefined when the header bag or value is absent", () => {
    expect(requireSingleHeaderValue(undefined, "authorization")).toBeUndefined();
    expect(requireSingleHeaderValue({}, "authorization")).toBeUndefined();
  });
});
