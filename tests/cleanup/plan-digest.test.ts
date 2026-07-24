/**
 * Strict canonicalizer + digests — Date handling and rejection of ambiguous
 * values a plain JSON-shaped stringify would silently mishash.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, computeManifestDigest } from "../../src/cleanup/index.js";

describe("canonicalJson", () => {
  it("is key-order invariant", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("serializes Date explicitly so timestamps participate in the digest", () => {
    const a = canonicalJson({ at: new Date("2026-07-24T00:00:00.000Z") });
    const b = canonicalJson({ at: new Date("2026-07-24T00:00:01.000Z") });
    expect(a).not.toBe(b); // the bug: both would hash as {} under a naive stringify
    expect(a).toContain("$date");
  });

  it("rejects non-finite numbers, bigint, function, symbol, undefined", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ b: 10n })).toThrow(/bigint/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ s: Symbol("x") })).toThrow(/symbol/);
    expect(() => canonicalJson({ u: undefined })).toThrow(/undefined/);
  });

  it("rejects Map / Set (ambiguous ordering)", () => {
    expect(() => canonicalJson({ m: new Map() })).toThrow(/Map/);
    expect(() => canonicalJson({ s: new Set() })).toThrow(/Set/);
  });

  it("rejects cyclic references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/cyclic/);
  });

  it("rejects an invalid Date", () => {
    expect(() => canonicalJson({ at: new Date("nope") })).toThrow(/invalid Date/);
  });
});

describe("computeManifestDigest", () => {
  it("changes when the completedAt timestamp changes", () => {
    const base = {
      runId: "r1",
      recipeId: "cleanup.drafts",
      completedAt: new Date("2026-07-24T00:00:00.000Z"),
      status: "completed",
    };
    const d1 = computeManifestDigest(base);
    const d2 = computeManifestDigest({
      ...base,
      completedAt: new Date("2026-07-24T01:00:00.000Z"),
    });
    expect(d1).not.toBe(d2);
  });

  it("excludes the manifestDigest field itself", () => {
    const base = { runId: "r1", completedAt: new Date("2026-07-24T00:00:00.000Z") };
    const d = computeManifestDigest(base);
    expect(computeManifestDigest({ ...base, manifestDigest: "whatever" })).toBe(d);
  });
});
