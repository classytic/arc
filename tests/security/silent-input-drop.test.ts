/**
 * PROOF: arc silently DROPS inputs it does not understand, on two paths.
 *
 * AGENTS.md (commerce) FAIL LOUD rule 2 — "an input you do not understand must
 * FAIL, not widen" — and for a FILTER, dropping does not fail, it WIDENS: the
 * caller asked for a narrower set and silently received a broader one.
 *
 * Both defects were observed live against a real deployment (2026-08-08):
 *
 *   GET ?filters[status]=pending&filters[flow]=inflow -> 200, 10 rows,
 *                                                        every one status:"verified"
 *   GET ?status=pending&flow=inflow                   -> 200, 0 rows
 *
 *   PATCH {"type":"rent"}  -> 200, body echoes "type":"purchase" (unchanged)
 *
 * The `*_CURRENT` tests characterise today's behaviour and PASS — they are the
 * proof the defect is arc's, not a consumer's. The `*_DESIRED` tests assert the
 * fix and FAIL until it lands. Do not delete the CURRENT tests when fixing;
 * invert them, so the characterisation stays pinned.
 */

import { describe, expect, it } from "vitest";
import { BodySanitizer, DEFAULT_FIELD_WRITE_DENIAL_POLICY } from "../../src/core/BodySanitizer.js";
import type { RouteSchemaOptions } from "../../src/types/index.js";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

describe("silent input drop — queryParser filter whitelist", () => {
  const parser = new ArcQueryParser({ allowedFilterFields: ["status", "flow"] });

  it("CURRENT: an unknown filter key is dropped, WIDENING the result set", () => {
    // The caller intends to narrow to pending rows. `nope` is not whitelisted.
    const result = parser.parse({ nope: "pending" });

    // Proof of the defect: no filter survives, so the query matches EVERYTHING.
    // src/utils/queryParser.ts:431 — `return` with no signal to the caller.
    expect(result.filters).toEqual({});
  });

  it("CURRENT: the bracket-envelope spelling is dropped the same way", () => {
    // This is the exact shape that shipped: `?filters[status]=pending`.
    // `filters` is not in allowedFilterFields, so the whole envelope vanishes.
    const result = parser.parse({ "filters[status]": "pending" });
    expect(result.filters).toEqual({});
  });

  it("CURRENT: a whitelisted key on its own does narrow correctly", () => {
    // Control — proves the parser works when the key IS allowed, so the two
    // tests above isolate the drop rather than a broken parser.
    const result = parser.parse({ status: "pending" });
    expect(result.filters).toEqual({ status: "pending" });
  });

  it("DESIRED: an unknown filter key is REFUSED, not silently dropped", () => {
    // A read that cannot honour the caller's narrowing must not answer as if
    // it had. Opt-in, because arc is published (see ARC_STRICT_PERMISSIONS
    // precedent: default off + loud warning, host turns it on in env-loader).
    const strict = new ArcQueryParser({
      allowedFilterFields: ["status", "flow"],
      strictFilterFields: true,
    });

    expect(() => strict.parse({ nope: "pending" })).toThrow(/nope/);
    // The bracket-envelope spelling that actually shipped must refuse too.
    expect(() => strict.parse({ "filters[status]": "pending" })).toThrow(/filters/);
    // A whitelisted key still parses — strictness must not break the happy path.
    expect(strict.parse({ status: "pending" }).filters).toEqual({ status: "pending" });
  });
});

describe("silent input drop — BodySanitizer immutable fields", () => {
  const schemaOptions: RouteSchemaOptions = {
    fieldRules: { type: { immutable: true } },
  };

  it("CURRENT: an immutable field is silently stripped on update", () => {
    // src/core/BodySanitizer.ts:100-102 — unconditional `delete`.
    // The caller is told 200 and nothing changed.
    const sanitizer = new BodySanitizer({ schemaOptions });
    expect(sanitizer.sanitize({ type: "rent" }, "update")).toEqual({});
  });

  it("CURRENT: the SAME sanitizer rejects a permission-denied write", () => {
    // This is the inconsistency, and it is the whole argument: arc ALREADY
    // decided that a write the caller may not perform should surface as an
    // error rather than a silent no-op. `onFieldWriteDenied` defaults to
    // 'reject' — "surface the misconfiguration as a 403" (BodySanitizer.ts:43).
    // Immutable/readonly/systemManaged never route through that policy.
    expect(DEFAULT_FIELD_WRITE_DENIAL_POLICY).toBe("reject");
  });

  it("DESIRED: an immutable write is REFUSED under the reject policy", () => {
    // Same treatment as a permission-denied write: one policy, one behaviour.
    const sanitizer = new BodySanitizer({ schemaOptions, onImmutableWrite: "reject" });
    expect(() => sanitizer.sanitize({ type: "rent" }, "update")).toThrow(/type/);
  });

  it("DESIRED: 'strip' still strips, so existing callers keep working", () => {
    const sanitizer = new BodySanitizer({ schemaOptions, onImmutableWrite: "strip" });
    expect(sanitizer.sanitize({ type: "rent" }, "update")).toEqual({});
  });

  it("DESIRED: the default stays 'strip' — a published framework must not break callers", () => {
    // The whole reason this is a separate knob from `onFieldWriteDenied`
    // (which defaults to 'reject'): a full-object PATCH echoing an unchanged
    // immutable field is legitimate and the sanitizer cannot detect it.
    const sanitizer = new BodySanitizer({ schemaOptions });
    expect(sanitizer.sanitize({ type: "rent" }, "update")).toEqual({});
  });

  it("CONTROL: create is unaffected — immutable only binds after creation", () => {
    const sanitizer = new BodySanitizer({ schemaOptions, onImmutableWrite: "reject" });
    expect(sanitizer.sanitize({ type: "rent" }, "create")).toEqual({ type: "rent" });
  });
});

/**
 * The reject policy must fire on an ATTEMPT, not on the mere EXISTENCE of a rule.
 *
 * The sanitizer walks `fieldRules`, not the body, so recording an attempt for
 * every immutable field rejected EVERY update on any resource that merely
 * declared one — a body that never mentioned the field still got a 403. That
 * makes the policy unusable rather than strict, and it slipped past the unit
 * tests above because each of them sends the immutable field.
 */
describe("immutable reject — only on an actual attempt", () => {
  const sanitizer = new BodySanitizer({
    schemaOptions: {
      fieldRules: { type: { immutable: true }, orgId: { immutable: true } },
    } as RouteSchemaOptions,
    onImmutableWrite: "reject",
  });

  it("does NOT reject an update that omits every immutable field", () => {
    expect(() => sanitizer.sanitize({ name: "ok" }, "update")).not.toThrow();
  });

  it("rejects as soon as one immutable field IS present", () => {
    expect(() => sanitizer.sanitize({ name: "ok", type: "rent" }, "update")).toThrow(
      /immutable field: type/,
    );
  });

  it("names every attempted field, not just the first", () => {
    expect(() => sanitizer.sanitize({ type: "rent", orgId: "o2" }, "update")).toThrow(
      /immutable fields: type, orgId/,
    );
  });
});
