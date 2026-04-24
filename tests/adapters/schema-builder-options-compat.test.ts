/**
 * Probe — arc's `RouteSchemaOptions` structurally matches repo-core's
 * `SchemaBuilderOptions` end to end, so host glue wiring mongokit /
 * sqlitekit / prismakit schema generators into arc needs **no cast** at
 * the options parameter.
 *
 * Before this alignment (2.11.0), hosts wrote:
 *
 *   createMongooseAdapter({
 *     schemaGenerator: (model, opts) =>
 *       buildCrudSchemasFromModel(
 *         model,
 *         opts as Parameters<typeof buildCrudSchemasFromModel>[1],  // ← cast
 *       ),
 *   });
 *
 * because arc's `RouteSchemaOptions` and repo-core's `SchemaBuilderOptions`
 * weren't structurally related — they shared `fieldRules` and
 * `strictAdditionalProperties` but arc was missing `dateAs`, `create.*`,
 * `update.*`, `softRequiredFields`, `openApiExtensions`.
 *
 * After: `RouteSchemaOptions extends SchemaBuilderOptions` (with
 * `ArcFieldRule extends FieldRule` for the per-entry shape). Hosts pass
 * `buildCrudSchemasFromModel` directly:
 *
 *   createMongooseAdapter({
 *     schemaGenerator: buildCrudSchemasFromModel,  // ← no cast, no wrapper
 *   });
 *
 * Every compile success below is evidence that a corresponding host-side
 * cast was defensive and can be deleted. Every compile failure would tell
 * us exactly which shape regressed and where.
 */

import { buildCrudSchemasFromModel } from "@classytic/mongokit";
import type {
  FieldRules,
  FieldRule as RepoCoreFieldRule,
  SchemaBuilderOptions,
} from "@classytic/repo-core/schema";
import { describe, expect, it } from "vitest";
import type { MongooseAdapterOptions } from "../../src/adapters/mongoose.js";
import type { ArcFieldRule, RouteSchemaOptions } from "../../src/types/index.js";

// ============================================================================
// Type-level checks — lock structural relationships at compile time
// ============================================================================

/**
 * Static assertion that `T` is assignable to `U`. If the relationship
 * breaks, the `_assert` variable fails to type-check and the whole file
 * fails to compile — giving us a loud, specific error.
 */
type AssertAssignable<T, U> = T extends U ? true : false;

// ── #1: arc's RouteSchemaOptions IS assignable to SchemaBuilderOptions ──
//
// This is the one that kills the `Parameters<typeof buildCrudSchemasFromModel>[1]`
// cast. Hosts who build an options bag typed as `RouteSchemaOptions` can
// pass it to `buildCrudSchemasFromModel(model, opts)` directly.
type _RouteOptsIsSchemaBuilderOpts = AssertAssignable<RouteSchemaOptions, SchemaBuilderOptions>;
const _route: _RouteOptsIsSchemaBuilderOpts = true;
void _route;

// ── #2: arc's ArcFieldRule IS assignable to repo-core's FieldRule ──
//
// The per-entry shape. Arc's extensions (`preserveForElevated`, `nullable`,
// `minLength`, etc.) live on top of repo-core's 4-field floor. Assignment
// the other way (FieldRule → ArcFieldRule) is NOT required because the
// richer shape is the consumer, not the producer.
type _ArcFieldRuleIsFieldRule = AssertAssignable<ArcFieldRule, RepoCoreFieldRule>;
const _rule: _ArcFieldRuleIsFieldRule = true;
void _rule;

// ── #3: arc's fieldRules map IS assignable to repo-core's FieldRules ──
//
// Record is covariant in V, so `Record<string, ArcFieldRule>` assigns into
// `Record<string, FieldRule>` = `FieldRules` because ArcFieldRule extends
// FieldRule. The mongokit schema generator reads the map through the
// FieldRules type and only sees the four floor flags.
type _ArcFieldRulesIsFieldRules = AssertAssignable<
  NonNullable<RouteSchemaOptions["fieldRules"]>,
  FieldRules
>;
const _rules: _ArcFieldRulesIsFieldRules = true;
void _rules;

// ============================================================================
// Direct assignment — no `as`, no `Parameters<...>[1]`
// ============================================================================

describe("RouteSchemaOptions ↔ SchemaBuilderOptions structural compat", () => {
  it("arc options bag passes to buildCrudSchemasFromModel without cast", () => {
    // Authored as RouteSchemaOptions — the type a host writes into
    // `defineResource({ schemaOptions: {...} })`.
    const arcOpts: RouteSchemaOptions = {
      // Arc-only fields — kit ignores these, but they must coexist with
      // the SchemaBuilderOptions fields on the same object.
      hiddenFields: ["password"],
      readonlyFields: ["createdAt"],
      excludeFields: ["_internal"],
      filterableFields: ["status", "name"],
      // Inherited SchemaBuilderOptions fields — kit reads these directly.
      strictAdditionalProperties: true,
      dateAs: "datetime",
      softRequiredFields: ["email"],
      create: {
        omitFields: ["status"],
        requiredOverrides: { name: true },
        optionalOverrides: { email: true },
      },
      update: { omitFields: ["id"], requireAtLeastOne: true },
      query: { filterableFields: { category: { type: "string" } } },
      openApiExtensions: false,
      // Arc's richer fieldRules — each entry is ArcFieldRule, inherited
      // systemManaged / immutable / optional / immutableAfterCreate are
      // recognized by the kit; the rest are arc-only extensions.
      fieldRules: {
        organizationId: {
          systemManaged: true,
          preserveForElevated: true,
        },
        priceMode: {
          nullable: true,
          enum: ["inclusive", "exclusive"],
          description: "Tax mode override",
        },
        slug: { systemManaged: true, pattern: "^[a-z0-9-]+$" },
      },
    };

    // The assignment that matters: `RouteSchemaOptions` satisfies
    // `SchemaBuilderOptions` without a cast. If this line fails to
    // compile, the alignment regressed — diagnose by finding the
    // SchemaBuilderOptions field arc's type no longer provides.
    const asSchemaBuilder: SchemaBuilderOptions = arcOpts;
    expect(asSchemaBuilder).toBe(arcOpts);
  });

  it("buildCrudSchemasFromModel plugs into arc's schemaGenerator callback type", () => {
    // The whole point of the alignment: a host can pass
    // `buildCrudSchemasFromModel` directly as a schemaGenerator. TS's
    // function parameter contravariance requires arc's declared `options`
    // type to be assignable to mongokit's expected `SchemaBuilderOptions`
    // — which the extension guarantees.
    const schemaGen: NonNullable<MongooseAdapterOptions["schemaGenerator"]> =
      buildCrudSchemasFromModel;

    expect(schemaGen).toBeDefined();
  });
});

// ============================================================================
// Regression — fields that should NOT exist on SchemaBuilderOptions remain
// arc-only (so kits never see them)
// ============================================================================

describe("arc-only fields stay arc-only after extension", () => {
  it("SchemaBuilderOptions view of an arc options bag hides arc-only keys", () => {
    // Runtime check: when a host casts down to `SchemaBuilderOptions`,
    // the arc-only keys are still present on the object (TS's view only
    // changes, not the value). This is expected — the `hidden` in the
    // type name refers to the type-level view, not the runtime shape.
    const arcOpts: RouteSchemaOptions = {
      hiddenFields: ["password"],
      fieldRules: { x: { nullable: true } },
    };
    const asSchemaBuilder: SchemaBuilderOptions = arcOpts;

    // `hiddenFields` isn't declared on SchemaBuilderOptions, so reading
    // it via `asSchemaBuilder.hiddenFields` would be a TS error — but
    // the runtime object still carries the key. Cast through `unknown`
    // to assert the runtime presence without fighting the type view.
    const runtimeShape = asSchemaBuilder as unknown as Record<string, unknown>;
    expect(runtimeShape.hiddenFields).toEqual(["password"]);
  });
});
