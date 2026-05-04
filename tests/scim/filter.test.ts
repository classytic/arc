/**
 * SCIM 2.0 filter parser (RFC 7644 §3.4.2.2)
 *
 * Covers what every IdP (Okta, Azure AD, Google Workspace, JumpCloud)
 * actually emits in production reconciliation.
 */

import { describe, expect, it } from "vitest";
import { ScimError } from "../../src/scim/errors.js";
import { IDENTITY_MAP, parseScimFilter } from "../../src/scim/filter.js";

describe("parseScimFilter — comparisons", () => {
  it("eq with string", () => {
    expect(parseScimFilter('userName eq "alice@acme.com"', IDENTITY_MAP)).toEqual({
      userName: "alice@acme.com",
    });
  });

  it("eq with boolean", () => {
    expect(parseScimFilter("active eq true", IDENTITY_MAP)).toEqual({ active: true });
  });

  it("eq with number", () => {
    expect(parseScimFilter("age eq 42", IDENTITY_MAP)).toEqual({ age: 42 });
  });

  it("ne", () => {
    expect(parseScimFilter('status ne "archived"', IDENTITY_MAP)).toEqual({
      status: { $ne: "archived" },
    });
  });

  it("gt / ge / lt / le", () => {
    expect(parseScimFilter("age gt 18", IDENTITY_MAP)).toEqual({ age: { $gt: 18 } });
    expect(parseScimFilter("age ge 18", IDENTITY_MAP)).toEqual({ age: { $gte: 18 } });
    expect(parseScimFilter("age lt 65", IDENTITY_MAP)).toEqual({ age: { $lt: 65 } });
    expect(parseScimFilter("age le 65", IDENTITY_MAP)).toEqual({ age: { $lte: 65 } });
  });

  it("co (contains)", () => {
    expect(parseScimFilter('name co "Smith"', IDENTITY_MAP)).toEqual({
      name: { $regex: "Smith", $options: "i" },
    });
  });

  it("sw (starts with)", () => {
    expect(parseScimFilter('userName sw "admin"', IDENTITY_MAP)).toEqual({
      userName: { $regex: "^admin", $options: "i" },
    });
  });

  it("ew (ends with)", () => {
    expect(parseScimFilter('userName ew "@acme.com"', IDENTITY_MAP)).toEqual({
      userName: { $regex: "@acme\\.com$", $options: "i" },
    });
  });

  it("pr (present)", () => {
    expect(parseScimFilter("title pr", IDENTITY_MAP)).toEqual({
      title: { $exists: true, $ne: null },
    });
  });

  it("escapes regex special chars in co/sw/ew operands", () => {
    expect(parseScimFilter('userName co ".*"', IDENTITY_MAP)).toEqual({
      userName: { $regex: "\\.\\*", $options: "i" },
    });
  });
});

describe("parseScimFilter — logical", () => {
  it("and", () => {
    expect(parseScimFilter('active eq true and userName sw "a"', IDENTITY_MAP)).toEqual({
      $and: [{ active: true }, { userName: { $regex: "^a", $options: "i" } }],
    });
  });

  it("or", () => {
    expect(parseScimFilter('userName eq "alice" or userName eq "bob"', IDENTITY_MAP)).toEqual({
      $or: [{ userName: "alice" }, { userName: "bob" }],
    });
  });

  it("not", () => {
    expect(parseScimFilter("not (active eq true)", IDENTITY_MAP)).toEqual({
      $nor: [{ active: true }],
    });
  });

  it("groups: and binds tighter than or", () => {
    expect(parseScimFilter("a eq 1 or b eq 2 and c eq 3", IDENTITY_MAP)).toEqual({
      $or: [{ a: 1 }, { $and: [{ b: 2 }, { c: 3 }] }],
    });
  });

  it("explicit grouping overrides precedence", () => {
    expect(parseScimFilter("(a eq 1 or b eq 2) and c eq 3", IDENTITY_MAP)).toEqual({
      $and: [{ $or: [{ a: 1 }, { b: 2 }] }, { c: 3 }],
    });
  });
});

describe("parseScimFilter — attribute mapping", () => {
  it("invokes mapper for backend field translation", () => {
    const mapper = (a: string) => ({ userName: "email", displayName: "name" })[a];
    expect(parseScimFilter('userName eq "x@y.z"', mapper)).toEqual({
      email: "x@y.z",
    });
    expect(parseScimFilter('displayName co "Alice"', mapper)).toEqual({
      name: { $regex: "Alice", $options: "i" },
    });
  });

  it("400s when mapper returns undefined for an unknown attribute", () => {
    const mapper = () => undefined;
    expect(() => parseScimFilter('xyz eq "1"', mapper)).toThrow(ScimError);
  });

  it("dotted SCIM paths (sub-attribute)", () => {
    expect(parseScimFilter('name.familyName sw "Smith"', IDENTITY_MAP)).toEqual({
      "name.familyName": { $regex: "^Smith", $options: "i" },
    });
  });
});

describe("parseScimFilter — error paths", () => {
  it("400s on unterminated string", () => {
    expect(() => parseScimFilter('userName eq "open', IDENTITY_MAP)).toThrow(ScimError);
  });

  it("400s on unknown operator", () => {
    expect(() => parseScimFilter('userName like "x"', IDENTITY_MAP)).toThrow();
  });

  it("400s on missing comparison value", () => {
    expect(() => parseScimFilter("userName eq", IDENTITY_MAP)).toThrow(ScimError);
  });

  it("empty filter → empty query (no-op)", () => {
    expect(parseScimFilter("", IDENTITY_MAP)).toEqual({});
    expect(parseScimFilter("   ", IDENTITY_MAP)).toEqual({});
  });
});

describe("parseScimFilter — production IdP filters", () => {
  it("Okta: userName + active reconciliation", () => {
    expect(
      parseScimFilter('userName eq "alice@acme.com" and active eq true', IDENTITY_MAP),
    ).toEqual({
      $and: [{ userName: "alice@acme.com" }, { active: true }],
    });
  });

  it("Azure AD: externalId lookup", () => {
    expect(parseScimFilter('externalId eq "ad:f3e9-..."', IDENTITY_MAP)).toEqual({
      externalId: "ad:f3e9-...",
    });
  });

  it("Google Workspace: meta.lastModified date filter", () => {
    expect(parseScimFilter('meta.lastModified gt "2025-01-01T00:00:00Z"', IDENTITY_MAP)).toEqual({
      "meta.lastModified": { $gt: "2025-01-01T00:00:00Z" },
    });
  });
});
