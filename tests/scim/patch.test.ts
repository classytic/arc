/**
 * SCIM 2.0 PATCH parser (RFC 7644 §3.5.2)
 */

import { describe, expect, it } from "vitest";
import { ScimError } from "../../src/scim/errors.js";
import { parseScimPatch, scimUpdateToFlatPatch } from "../../src/scim/patch.js";

describe("parseScimPatch — basic ops", () => {
  it("replace simple attribute", () => {
    const result = parseScimPatch({
      Operations: [{ op: "replace", path: "displayName", value: "Alice S." }],
    });
    expect(result.$set).toEqual({ displayName: "Alice S." });
    expect(result.$push).toEqual({});
    expect(result.$unset).toEqual({});
  });

  it("add simple attribute (single value)", () => {
    const result = parseScimPatch({
      Operations: [{ op: "add", path: "department", value: "Eng" }],
    });
    expect(result.$set).toEqual({ department: "Eng" });
  });

  it("add multi-value (array push without filter)", () => {
    const result = parseScimPatch({
      Operations: [
        { op: "add", path: "emails", value: [{ value: "alt@x.com", type: "personal" }] },
      ],
    });
    expect(result.$push).toEqual({
      emails: { $each: [{ value: "alt@x.com", type: "personal" }] },
    });
  });

  it("remove simple attribute", () => {
    const result = parseScimPatch({
      Operations: [{ op: "remove", path: "title" }],
    });
    expect(result.$unset).toEqual({ title: true });
  });

  it("path-less object value spreads into $set", () => {
    const result = parseScimPatch({
      Operations: [{ op: "replace", value: { displayName: "Bob", active: false } }],
    });
    expect(result.$set).toEqual({ displayName: "Bob", active: false });
  });

  it("dotted sub-attribute path", () => {
    const result = parseScimPatch({
      Operations: [{ op: "replace", path: "name.familyName", value: "Smith" }],
    });
    expect(result.$set).toEqual({ "name.familyName": "Smith" });
  });
});

describe("parseScimPatch — multi-value with filter", () => {
  it("remove with bracketed filter → $pull with __scimFilter", () => {
    const result = parseScimPatch({
      Operations: [{ op: "remove", path: 'emails[type eq "work"]' }],
    });
    expect(result.$pull.emails).toBeDefined();
    expect((result.$pull.emails as { __scimFilter: string }).__scimFilter).toContain("type eq");
  });
});

describe("parseScimPatch — error paths", () => {
  it("rejects empty operation list", () => {
    expect(() => parseScimPatch({ Operations: [] })).toThrow(ScimError);
  });

  it("rejects unknown op verb", () => {
    expect(() =>
      parseScimPatch({ Operations: [{ op: "frobnicate", path: "x", value: 1 }] }),
    ).toThrow(ScimError);
  });

  it("rejects path-less remove", () => {
    expect(() => parseScimPatch({ Operations: [{ op: "remove" }] })).toThrow(ScimError);
  });

  it("rejects path-less add with non-object value", () => {
    expect(() => parseScimPatch({ Operations: [{ op: "add", value: "string" }] })).toThrow(
      ScimError,
    );
  });

  it("accepts lowercase 'operations' alias (some IdPs)", () => {
    const result = parseScimPatch({
      operations: [{ op: "replace", path: "displayName", value: "X" }],
    });
    expect(result.$set).toEqual({ displayName: "X" });
  });
});

describe("scimUpdateToFlatPatch", () => {
  it("flattens $set + $unset into a single patch object", () => {
    const update = parseScimPatch({
      Operations: [
        { op: "replace", path: "displayName", value: "Alice" },
        { op: "remove", path: "title" },
      ],
    });
    expect(scimUpdateToFlatPatch(update)).toEqual({
      displayName: "Alice",
      title: null,
    });
  });
});
