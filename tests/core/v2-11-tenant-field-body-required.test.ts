/**
 * v2.11.0 — tenant field must be stripped from body-schema `required[]`.
 *
 * **The bug this locks in (pricelist / be-prod report):**
 *
 * A resource uses `multiTenantPreset` (tenant-injection preHandler
 * populates `organizationId` from the `x-organization-id` header). The
 * underlying engine is built with `@classytic/primitives`, whose
 * `resolveTenantConfig()` defaults to `tenant: { required: true }`.
 * That stamps `organizationId: { required: true }` on the Mongoose
 * schema, and arc's mongoose adapter faithfully reflects that into the
 * auto-generated `createBody` / `updateBody` schema's `required[]`.
 *
 * Fastify's preValidation runs BEFORE arc's preHandler chain — so the
 * request is rejected with `must have required property 'organizationId'`
 * before `multiTenantPreset` gets a chance to inject. The client
 * correctly passed `x-organization-id` in the header and is told the
 * body is wrong.
 *
 * **The fix (v2.11.0):** after the adapter generates body schemas,
 * strip the tenant field from `required[]` on both `createBody` and
 * `updateBody`. `properties` is left intact so elevated admins (whose
 * scope lacks a pinned org) can still pick a target org via the body.
 *
 * See `src/core/schemaOptions.ts :: stripTenantFieldFromBodyRequired`.
 */

import { describe, expect, it } from "vitest";
import {
  autoInjectTenantFieldRules,
  stripSystemManagedFromBodyRequired,
} from "../../src/core/schemaOptions.js";
import type { DataAdapter } from "../../src/types/index.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";

describe("v2.11.0 — stripSystemManagedFromBodyRequired (unit, fieldRule-driven)", () => {
  it("removes any systemManaged field from createBody.required", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          name: { type: "string" },
          organizationId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        },
        required: ["name", "organizationId"],
      },
      updateBody: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
    };

    const stripped = stripSystemManagedFromBodyRequired(schemas, {
      fieldRules: { organizationId: { systemManaged: true } },
    });

    expect(stripped?.createBody).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        // properties preserved — advanced callers can still send it
        organizationId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
      },
      required: ["name"], // organizationId removed
    });
    // updateBody unchanged (field wasn't in required[] to begin with)
    expect(stripped?.updateBody).toEqual(schemas.updateBody);
  });

  it("strips MULTIPLE systemManaged fields in one pass (tenant + auditedPreset fields)", () => {
    // Real-world combo: multiTenant + audited presets. Both declare
    // systemManaged fields — we want one pass that strips them all.
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          name: { type: "string" },
          organizationId: { type: "string" },
          createdBy: { type: "string" },
          updatedBy: { type: "string" },
        },
        required: ["name", "organizationId", "createdBy"],
      },
    };

    const stripped = stripSystemManagedFromBodyRequired(schemas, {
      fieldRules: {
        organizationId: { systemManaged: true, preserveForElevated: true },
        createdBy: { systemManaged: true },
        updatedBy: { systemManaged: true },
      },
    });

    expect((stripped?.createBody as { required: string[] }).required).toEqual(["name"]);
  });

  it("strips systemManaged fields from updateBody.required when requires it", () => {
    const schemas = {
      updateBody: {
        type: "object",
        properties: {
          name: { type: "string" },
          organizationId: { type: "string" },
        },
        required: ["organizationId"],
      },
    };

    const stripped = stripSystemManagedFromBodyRequired(schemas, {
      fieldRules: { organizationId: { systemManaged: true } },
    });

    // required[] was just [organizationId], strip empties it → property removed entirely
    expect(stripped?.updateBody).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        organizationId: { type: "string" },
      },
    });
  });

  it("respects a custom tenantField name (workspaceId)", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: { workspaceId: { type: "string" }, name: { type: "string" } },
        required: ["workspaceId", "name"],
      },
    };

    const stripped = stripSystemManagedFromBodyRequired(schemas, {
      fieldRules: { workspaceId: { systemManaged: true } },
    });

    expect(stripped?.createBody).toEqual({
      type: "object",
      properties: { workspaceId: { type: "string" }, name: { type: "string" } },
      required: ["name"],
    });
  });

  it("no-op when no rule has systemManaged: true", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };

    // rule exists but isn't systemManaged — should NOT touch required[]
    const stripped = stripSystemManagedFromBodyRequired(schemas, {
      fieldRules: { name: { minLength: 1 } },
    });

    expect(stripped).toBe(schemas);
  });

  it("no-op when schemaOptions is undefined", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };

    const stripped = stripSystemManagedFromBodyRequired(schemas, undefined);

    expect(stripped).toBe(schemas);
  });

  it("no-op when fieldRules is undefined", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };

    const stripped = stripSystemManagedFromBodyRequired(schemas, {});

    expect(stripped).toBe(schemas);
  });

  it("no-op when the systemManaged field isn't in required[] (already required:false)", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          name: { type: "string" },
          organizationId: { type: "string" },
        },
        required: ["name"],
      },
    };

    const stripped = stripSystemManagedFromBodyRequired(schemas, {
      fieldRules: { organizationId: { systemManaged: true } },
    });

    expect(stripped?.createBody).toEqual(schemas.createBody);
  });

  it("no-op when schemas is undefined (adapter generated nothing)", () => {
    const stripped = stripSystemManagedFromBodyRequired(undefined, {
      fieldRules: { organizationId: { systemManaged: true } },
    });
    expect(stripped).toBeUndefined();
  });

  it("does not mutate the input (returns a fresh schemas object)", () => {
    const input = {
      createBody: {
        type: "object",
        properties: { organizationId: { type: "string" } },
        required: ["organizationId"],
      },
    };
    const before = JSON.parse(JSON.stringify(input));

    stripSystemManagedFromBodyRequired(input, {
      fieldRules: { organizationId: { systemManaged: true } },
    });

    expect(input).toEqual(before);
  });
});

describe("v2.11.0 — defineResource integration (end-to-end)", () => {
  it("strips organizationId from the registered adapter-generated createBody.required", () => {
    // Mock a mongoose-style adapter that returns schemas with organizationId
    // in required[] — mirrors what `@classytic/primitives`-backed engines do.
    const adapter: DataAdapter = {
      type: "mock",
      name: "mock-with-required-tenant",
      repository: {
        async getAll() {
          return { docs: [], total: 0 };
        },
        async getById() {
          return null;
        },
        async create(d: unknown) {
          return d;
        },
        async update() {
          return null;
        },
        async delete() {
          return { acknowledged: true, deletedCount: 0 };
        },
      } as unknown as DataAdapter["repository"],
      generateSchemas: () => ({
        createBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            currency: { type: "string" },
            organizationId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
          },
          required: ["name", "currency", "organizationId"],
        },
        updateBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            organizationId: { type: "string" },
          },
          required: [],
        },
      }),
    };

    const resource = defineResource({
      name: "pricelist",
      adapter,
      tenantField: "organizationId",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Pull the registered schemas back out of the resource metadata
    const schemas = (
      resource as unknown as {
        _registryMeta?: { openApiSchemas?: { createBody?: Record<string, unknown> } };
      }
    )._registryMeta?.openApiSchemas;

    expect(schemas).toBeDefined();
    const createBody = schemas?.createBody as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    // The core assertion — tenant field stripped from required[]
    expect(createBody?.required).toEqual(["name", "currency"]);
    // But the property definition is preserved (elevated admins can still send it)
    expect(createBody?.properties).toHaveProperty("organizationId");
  });

  it("honors a custom tenantField ('workspaceId') at the defineResource layer", () => {
    const adapter: DataAdapter = {
      type: "mock",
      name: "mock-workspace",
      repository: {
        async getAll() {
          return { docs: [], total: 0 };
        },
        async getById() {
          return null;
        },
        async create(d: unknown) {
          return d;
        },
        async update() {
          return null;
        },
        async delete() {
          return { acknowledged: true, deletedCount: 0 };
        },
      } as unknown as DataAdapter["repository"],
      generateSchemas: () => ({
        createBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            workspaceId: { type: "string" },
          },
          required: ["name", "workspaceId"],
        },
      }),
    };

    const resource = defineResource({
      name: "doc",
      adapter,
      tenantField: "workspaceId",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const schemas = (
      resource as unknown as {
        _registryMeta?: { openApiSchemas?: { createBody?: Record<string, unknown> } };
      }
    )._registryMeta?.openApiSchemas;
    const createBody = schemas?.createBody as { required?: string[] } | undefined;

    expect(createBody?.required).toEqual(["name"]);
  });

  it("leaves required[] alone when tenantField: false (platform-universal resource)", () => {
    // A platform resource (no org scoping) must keep its required[] intact —
    // strip-tenant logic must not touch it.
    const adapter: DataAdapter = {
      type: "mock",
      name: "mock-platform",
      repository: {
        async getAll() {
          return { docs: [], total: 0 };
        },
        async getById() {
          return null;
        },
        async create(d: unknown) {
          return d;
        },
        async update() {
          return null;
        },
        async delete() {
          return { acknowledged: true, deletedCount: 0 };
        },
      } as unknown as DataAdapter["repository"],
      generateSchemas: () => ({
        createBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            organizationId: { type: "string" },
          },
          required: ["name", "organizationId"],
        },
      }),
    };

    const resource = defineResource({
      name: "platform-thing",
      adapter,
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const schemas = (
      resource as unknown as {
        _registryMeta?: { openApiSchemas?: { createBody?: Record<string, unknown> } };
      }
    )._registryMeta?.openApiSchemas;
    const createBody = schemas?.createBody as { required?: string[] } | undefined;

    // required[] unchanged — platform resources CAN require organizationId
    // if they choose to (e.g. a workspace that links to an org by FK).
    expect(createBody?.required).toEqual(["name", "organizationId"]);
  });

  it("companion check: autoInjectTenantFieldRules still runs (systemManaged + preserveForElevated)", () => {
    // Guard against regression: the schema-level fix (strip required) must
    // not replace the runtime-level fix (strip the value via BodySanitizer).
    // Both layers exist for defense-in-depth. v2.10.8 auto-injected
    // systemManaged; v2.11.0 adds the required-array fix.
    const base = { fieldRules: {} };
    const out = autoInjectTenantFieldRules(base, "organizationId");

    expect(out?.fieldRules?.organizationId).toMatchObject({
      systemManaged: true,
      preserveForElevated: true,
    });
  });
});

describe("v2.11.0 — multiTenantPreset declares fieldRules (pricelist bug repro)", () => {
  // The actual bug report: defineResource uses `multiTenantPreset`
  // WITHOUT setting `tenantField` at the resource level. Pre-fix, this
  // left `resolvedConfig.tenantField` undefined, `autoInjectTenantFieldRules`
  // was a no-op, and the adapter's `required[]` still demanded
  // organizationId. v2.11.0 fix: multiTenantPreset returns schemaOptions
  // with systemManaged rules — which applyPresets merges into
  // resolvedConfig.schemaOptions.fieldRules — which
  // stripSystemManagedFromBodyRequired then walks at schema-generation time.

  it("single-field: multiTenantPreset({ tenantField: 'organizationId' }) adds the systemManaged rule", () => {
    const result = multiTenantPreset({ tenantField: "organizationId" });
    expect(result.schemaOptions?.fieldRules?.organizationId).toMatchObject({
      systemManaged: true,
      preserveForElevated: true,
    });
  });

  it("multi-field: multiTenantPreset({ tenantFields: [...] }) adds rules for every dimension", () => {
    const result = multiTenantPreset({
      tenantFields: [
        { field: "organizationId", type: "org" },
        { field: "teamId", type: "team" },
        { field: "branchId", contextKey: "branchId" },
      ],
    });
    expect(result.schemaOptions?.fieldRules?.organizationId).toMatchObject({
      systemManaged: true,
    });
    expect(result.schemaOptions?.fieldRules?.teamId).toMatchObject({
      systemManaged: true,
    });
    expect(result.schemaOptions?.fieldRules?.branchId).toMatchObject({
      systemManaged: true,
    });
  });

  it("defaults: multiTenantPreset() with no options still declares the default organizationId rule", () => {
    const result = multiTenantPreset();
    expect(result.schemaOptions?.fieldRules?.organizationId).toMatchObject({
      systemManaged: true,
    });
  });

  it("END-TO-END: pricelist-style resource (preset without resource-level tenantField) strips required[]", () => {
    // EXACT repro of the reported bug:
    //   defineResource({ name: 'pricelist', adapter: ..., presets: [orgScoped] })
    //   → WITHOUT tenantField at the resource level
    //   → engine's Mongoose schema declares organizationId: { required: true }
    //   → pre-2.11 outcome: 400 "must have required property 'organizationId'"
    //   → v2.11 outcome: 201, with organizationId injected from x-organization-id header
    const adapter: DataAdapter = {
      type: "mock",
      name: "mock-pricelist-engine",
      repository: {
        async getAll() {
          return { docs: [], total: 0 };
        },
        async getById() {
          return null;
        },
        async create(d: unknown) {
          return d;
        },
        async update() {
          return null;
        },
        async delete() {
          return { acknowledged: true, deletedCount: 0 };
        },
      } as unknown as DataAdapter["repository"],
      generateSchemas: () => ({
        // Mirrors what `@classytic/primitives`-backed engines generate when
        // `resolveTenantConfig()` defaults `required: true`.
        createBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            currency: { type: "string" },
            organizationId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
          },
          required: ["name", "currency", "organizationId"],
        },
      }),
    };

    const resource = defineResource({
      name: "pricelist",
      adapter,
      // Note: NO tenantField at the resource level — relying on the preset
      presets: [multiTenantPreset({ tenantField: "organizationId" })],
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const schemas = (
      resource as unknown as {
        _registryMeta?: { openApiSchemas?: { createBody?: Record<string, unknown> } };
      }
    )._registryMeta?.openApiSchemas;
    const createBody = schemas?.createBody as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;

    // THE CRITICAL ASSERTION: organizationId stripped from required[]
    expect(createBody?.required).toEqual(["name", "currency"]);
    // Property preserved so elevated admins can still pick a target org
    expect(createBody?.properties).toHaveProperty("organizationId");
  });

  it("END-TO-END: audited + multiTenant combined (createdBy AND organizationId both stripped)", () => {
    // Two presets declaring systemManaged fields — both must be stripped
    // from required[] in a single pass.
    const adapter: DataAdapter = {
      type: "mock",
      name: "mock-audited-tenant",
      repository: {
        async getAll() {
          return { docs: [], total: 0 };
        },
        async getById() {
          return null;
        },
        async create(d: unknown) {
          return d;
        },
        async update() {
          return null;
        },
        async delete() {
          return { acknowledged: true, deletedCount: 0 };
        },
      } as unknown as DataAdapter["repository"],
      generateSchemas: (schemaOptions) => {
        // Mimic a kit-honest generator: emit required[] but respect
        // fieldRules.systemManaged to skip declaring those fields as
        // required. (Our real mongoose adapter built-in does this, but
        // kit-custom generators may not.)
        const properties: Record<string, unknown> = {
          name: { type: "string" },
          organizationId: { type: "string" },
          createdBy: { type: "string" },
        };
        const rules = schemaOptions?.fieldRules ?? {};
        const required = ["name", "organizationId", "createdBy"].filter(
          (f) => !(rules[f]?.systemManaged === true && rules[f]?.hidden !== false),
        );
        // Intentionally do NOT strip — simulate the kit-generator path that
        // ignores systemManaged. Arc's post-processor must catch it.
        return {
          createBody: {
            type: "object",
            properties,
            required: ["name", "organizationId", "createdBy"],
          },
        };
        // `required` (filtered) left unused in this mock — point of the test
        // is that arc's post-processor ALSO runs for defense in depth.
      },
    };

    const resource = defineResource({
      name: "audited-tenant-doc",
      adapter,
      tenantField: "organizationId", // also auto-inject path active
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      // Host-declared createdBy rule (what `auditedPreset` would do too)
      schemaOptions: {
        fieldRules: {
          createdBy: { systemManaged: true },
        },
      },
    });

    const schemas = (
      resource as unknown as {
        _registryMeta?: { openApiSchemas?: { createBody?: Record<string, unknown> } };
      }
    )._registryMeta?.openApiSchemas;
    const createBody = schemas?.createBody as { required?: string[] } | undefined;

    // Both systemManaged fields stripped in one pass
    expect(createBody?.required).toEqual(["name"]);
  });
});
