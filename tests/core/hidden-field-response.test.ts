/**
 * `schemaOptions.fieldRules[x].hidden` must omit the field from RESPONSES.
 *
 * `hidden` was documented as "not readable" in two independent places — the
 * predicate docblock in `core/fieldRulePredicates.ts` and arc's own adapter test
 * ("hidden — must never appear in API", "never surfaced") — and enforced on three
 * surfaces: `select=`, `_distinct`, and aggregations. The response body, the one
 * that actually ships the value to a client, was not among them.
 *
 * So a resource declaring `fieldRules: { secret: { hidden: true } }` rejected the
 * field on writes, dropped it from the generated schemas, refused to aggregate it
 * — and returned it in every `GET`. Nothing threw. The promise was true of three
 * quarters of itself.
 *
 * `arcDecorator` now derives a `hidden()` field PERMISSION from the rule, so the
 * single existing response stripper enforces it. These pin the derivation; the
 * stripper itself is covered by the field-permission suite.
 */
import { describe, expect, it } from "vitest";
import { deriveHiddenFieldPermissions, fields } from "../../src/permissions/fields.js";

describe("hidden fieldRules become read permissions", () => {
  it("derives a hidden permission for a field marked hidden", () => {
    const derived = deriveHiddenFieldPermissions(
      { fieldRules: { secret: { hidden: true } } },
      undefined,
    );
    expect(derived).toEqual({ secret: { _type: "hidden" } });
  });

  it("ignores rules that are not hidden — systemManaged is a WRITE rule", () => {
    const derived = deriveHiddenFieldPermissions(
      { fieldRules: { status: { systemManaged: true }, createdAt: { readonly: true } } },
      undefined,
    );
    // Conflating the two is what once over-blocked reads of server-stamped fields.
    expect(derived).toBeUndefined();
  });

  it.each([
    ["no schemaOptions", undefined],
    ["schemaOptions without fieldRules", {}],
    ["empty fieldRules", { fieldRules: {} }],
  ])("%s leaves the explicit map untouched", (_label, schemaOptions) => {
    const explicit = { password: fields.hidden() };
    expect(deriveHiddenFieldPermissions(schemaOptions, explicit)).toBe(explicit);
  });

  it("merges derived rules alongside unrelated explicit ones", () => {
    const derived = deriveHiddenFieldPermissions({ fieldRules: { secret: { hidden: true } } }, {
      salary: fields.visibleTo(["admin"]),
    });
    expect(derived).toEqual({
      secret: { _type: "hidden" },
      salary: { _type: "visibleTo", roles: ["admin"] },
    });
  });

  /**
   * The explicit map is the more SPECIFIC statement about visibility, so a broad
   * query-surface flag must not silently override it — that is a general default
   * defeating a specific instruction.
   */
  it("an explicit fields entry WINS over the derived one", () => {
    const derived = deriveHiddenFieldPermissions({ fieldRules: { salary: { hidden: true } } }, {
      salary: fields.visibleTo(["admin", "hr"]),
    });
    expect(derived?.salary).toEqual({ _type: "visibleTo", roles: ["admin", "hr"] });
  });

  it("returns undefined when there is nothing to apply — callers early-out on it", () => {
    expect(deriveHiddenFieldPermissions(undefined, undefined)).toBeUndefined();
  });
});

/**
 * The WIRING, which the helper tests above cannot see: `arcDecorator` is what
 * puts the derived permission on `req.arc.fields`, and `sendControllerResponse`
 * strips from there. Without this the helper is correct and unreachable.
 */
describe("arcDecorator stamps the derived permissions onto req.arc", () => {
  const stamp = async (meta: Record<string, unknown>) => {
    const { buildArcDecorator } = await import("../../src/core/middlewares/arcDecorator.js");
    const decorate = buildArcDecorator(meta as never);
    const req = {} as Record<string, unknown>;
    await (decorate as (r: unknown, y: unknown) => Promise<void>)(req, {});
    return (req.arc as { fields?: Record<string, unknown> }).fields;
  };

  it("a hidden fieldRule reaches req.arc.fields", async () => {
    const stamped = await stamp({
      resourceName: "order",
      schemaOptions: { fieldRules: { partyId: { hidden: true } } },
      permissions: {},
      hooks: {},
      events: {},
      fields: undefined,
    });
    expect(stamped).toEqual({ partyId: { _type: "hidden" } });
  });

  it("leaves req.arc.fields undefined when nothing is hidden", async () => {
    const stamped = await stamp({
      resourceName: "order",
      schemaOptions: { fieldRules: { status: { systemManaged: true } } },
      permissions: {},
      hooks: {},
      events: {},
      fields: undefined,
    });
    // `sendControllerResponse` skips the stripper entirely on undefined — keeping
    // that shape avoids paying for a no-op mask on every response.
    expect(stamped).toBeUndefined();
  });
});
