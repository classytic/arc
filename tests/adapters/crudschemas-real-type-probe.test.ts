/**
 * Probe — does mongokit 3.11.1's `buildCrudSchemasFromModel` plug into arc's
 * `schemaGenerator` callback without a cast?
 *
 * mongokit 3.11.1 changed the return type from `CrudSchemas` to
 * `CrudSchemasFramework = CrudSchemas & Record<string, unknown>` — a pure
 * TypeScript-level widening. Runtime output is byte-identical to 3.11.0;
 * the intersection only adds the index signature TS needs for assignment
 * into arc's `schemaGenerator` return union
 * (`OpenApiSchemas | Record<string, unknown>`).
 *
 * If this file typechecks, the cast is gone — no `as unknown as
 * Record<string, unknown>` anywhere. If it fails to compile, mongokit's
 * widening regressed and hosts are back to writing casts.
 */

import { buildCrudSchemasFromModel } from "@classytic/mongokit";
import { describe, expect, it } from "vitest";
import type { MongooseAdapterOptions } from "../../src/adapters/mongoose.js";

describe("mongokit 3.11.1 — buildCrudSchemasFromModel plugs into arc without cast", () => {
  it("direct assignment to arc's schemaGenerator callback type (no cast)", () => {
    // Type-level check: fails to compile if mongokit's return type no
    // longer satisfies arc's `schemaGenerator` return union.
    //
    // Host-side code for arc consumers after this fix:
    //   createMongooseAdapter({
    //     model: JobModel,
    //     repository: jobRepository,
    //     schemaGenerator: buildCrudSchemasFromModel,   // ← no cast
    //   });
    const asArcGen: NonNullable<MongooseAdapterOptions["schemaGenerator"]> =
      buildCrudSchemasFromModel;

    expect(asArcGen).toBeDefined();
  });
});
