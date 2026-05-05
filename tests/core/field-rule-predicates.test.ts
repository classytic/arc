/**
 * Tests for the shared field-rule predicates.
 *
 * Covers the conflation fix (`systemManaged` no longer blocks read-side
 * surfaces) and the canonical `hidden`-only rule that aggregation,
 * `_distinct`, and `select=` sanitisation now share.
 */

import { describe, expect, it } from "vitest";
import {
  collectReadBlockedFields,
  isFieldReadable,
} from "../../src/core/fieldRulePredicates.js";

describe("isFieldReadable", () => {
  it("treats undefined rule as readable (no entry → no rule)", () => {
    expect(isFieldReadable(undefined)).toBe(true);
  });

  it("treats empty rule as readable", () => {
    expect(isFieldReadable({})).toBe(true);
  });

  it("blocks `hidden: true`", () => {
    expect(isFieldReadable({ hidden: true })).toBe(false);
  });

  it("ALLOWS `systemManaged: true` — write rule only, doesn't gate reads", () => {
    // `systemManaged` means the server stamps the value; clients can't
    // PATCH it. The field IS still in every list/get response, so
    // gating reads on it is over-conservative. Pre-fix, this case
    // returned `false`.
    expect(isFieldReadable({ systemManaged: true })).toBe(true);
  });

  it("ALLOWS `readonly: true` — also a write rule", () => {
    expect(isFieldReadable({ readonly: true })).toBe(true);
  });

  it("ALLOWS `immutable: true` — write rule (immutable after create)", () => {
    expect(isFieldReadable({ immutable: true })).toBe(true);
  });

  it("`hidden: true` AND `systemManaged: true` still blocks", () => {
    expect(isFieldReadable({ hidden: true, systemManaged: true })).toBe(false);
  });
});

describe("collectReadBlockedFields", () => {
  it("returns null when schemaOptions is undefined (early-out signal)", () => {
    expect(collectReadBlockedFields(undefined)).toBe(null);
  });

  it("returns null when no fieldRules entries", () => {
    expect(collectReadBlockedFields({})).toBe(null);
  });

  it("returns null when fieldRules is empty object", () => {
    expect(collectReadBlockedFields({ fieldRules: {} })).toBe(null);
  });

  it("returns null when no rule blocks reads (only write rules)", () => {
    // The historical bug was returning `["createdAt", "status"]` here
    // and stripping them from `select=` queries.
    expect(
      collectReadBlockedFields({
        fieldRules: {
          createdAt: { systemManaged: true },
          status: { systemManaged: true },
          updatedAt: { readonly: true },
        },
      }),
    ).toBe(null);
  });

  it("collects only `hidden` fields", () => {
    const blocked = collectReadBlockedFields({
      fieldRules: {
        passwordHash: { hidden: true },
        secretToken: { hidden: true },
        createdAt: { systemManaged: true },
        email: {},
      },
    });
    expect(blocked).not.toBe(null);
    expect(blocked!.has("passwordHash")).toBe(true);
    expect(blocked!.has("secretToken")).toBe(true);
    expect(blocked!.has("createdAt")).toBe(false);
    expect(blocked!.has("email")).toBe(false);
    expect(blocked!.size).toBe(2);
  });

  it("ignores undefined rule entries safely", () => {
    expect(
      collectReadBlockedFields({
        fieldRules: {
          // biome-ignore lint/suspicious/noExplicitAny: testing defensive branch
          weird: undefined as any,
          passwordHash: { hidden: true },
        },
      }),
    ).toEqual(new Set(["passwordHash"]));
  });
});
