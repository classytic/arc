/**
 * Schema-pipeline characterization suite (2.21).
 *
 * `resolveOpenApiSchemas` (Phase 7 of defineResource) is a six-step pure
 * pipeline; until this file it had NO direct tests — every step was only
 * exercised incidentally through e2e suites, which is exactly how the
 * customSchemas precedence bug stayed dormant. Each test pins ONE step's
 * contract so a future change to any step fails HERE with a named reason,
 * not three suites away in a host's integration run.
 *
 * Pipeline (see src/core/defineResource/schemas.ts):
 *   adapter.generateSchemas()
 *     → stripSystemManagedFromBodyRequired
 *     → cleanLegacyObjectIdParams
 *     → layerQueryParserListQuery
 *     → applyResourcePaginationCaps
 *     → mergeUserOpenApiOverrides
 *     → convertOpenApiSchemas
 *
 * (The ROUTE-validation half — buildGeneratedCrudSchemas + customSchemas
 * part-level precedence — is pinned in custom-schemas-precedence.test.ts
 * and resource-plugin-schema-synthesis.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { resolveOpenApiSchemas } from "../../src/core/defineResource/schemas.js";
import type { ResourceConfig } from "../../src/types/index.js";

/** Minimal adapter whose generateSchemas returns a controlled shape. */
function fakeAdapter(schemas: Record<string, unknown>) {
  return {
    repository: {},
    generateSchemas: (_options: unknown, context: { idField?: string; resourceName?: string }) => ({
      ...schemas,
      __context: context,
    }),
  };
}

const BASE_SCHEMAS = {
  createBody: {
    type: "object",
    required: ["name", "totalDebit", "organizationId"],
    properties: {
      name: { type: "string" },
      totalDebit: { type: "number" },
      organizationId: { type: "string" },
    },
  },
  updateBody: {
    type: "object",
    required: ["totalDebit"],
    properties: { totalDebit: { type: "number" } },
  },
  params: {
    type: "object",
    properties: { id: { type: "string", pattern: "^[0-9a-fA-F]{24}$" } },
  },
  listQuery: { type: "object", properties: {} },
};

function config(overrides: Partial<ResourceConfig> = {}): ResourceConfig {
  return {
    name: "widget",
    adapter: fakeAdapter(BASE_SCHEMAS) as never,
    ...overrides,
  } as ResourceConfig;
}

function schemasOf(result: ReturnType<typeof resolveOpenApiSchemas>) {
  return result?.openApiSchemas as Record<string, Record<string, unknown>>;
}

describe("resolveOpenApiSchemas — pipeline characterization", () => {
  it("step 1: delegates to adapter.generateSchemas with idField + resourceName context", () => {
    const out = schemasOf(resolveOpenApiSchemas(config({ idField: "slug" })));
    expect(out.__context).toEqual({ idField: "slug", resourceName: "widget" });
  });

  it("step 2: systemManaged fieldRules strip from BOTH create and update required[]", () => {
    const out = schemasOf(
      resolveOpenApiSchemas(
        config({
          schemaOptions: {
            fieldRules: {
              totalDebit: { systemManaged: true },
              organizationId: { systemManaged: true },
            },
          },
        }),
      ),
    );
    expect(out.createBody.required).toEqual(["name"]);
    expect((out.updateBody.required ?? []) as string[]).not.toContain("totalDebit");
    // Properties stay — the field remains readable/documented, just not
    // demanded from the client.
    expect(out.createBody.properties).toHaveProperty("totalDebit");
  });

  it("step 3: a custom idField strips the legacy ObjectId pattern from params.id", () => {
    const out = schemasOf(resolveOpenApiSchemas(config({ idField: "slug" })));
    const id = (out.params.properties as Record<string, Record<string, unknown>>).id;
    expect(id.pattern).toBeUndefined();
  });

  it("step 3 inverse: default _id keeps the ObjectId pattern", () => {
    const out = schemasOf(resolveOpenApiSchemas(config()));
    const id = (out.params.properties as Record<string, Record<string, unknown>>).id;
    expect(id.pattern).toBe("^[0-9a-fA-F]{24}$");
  });

  it("step 4: the queryParser's getQuerySchema() REPLACES the adapter listQuery wholesale", () => {
    // The parser is the source of truth for filter validation — its schema
    // wins over whatever the adapter generated. (Route-side AJV-strict
    // normalization is a separate step in plugin.ts, pinned there.)
    const queryParser = {
      parse: (q: unknown) => q,
      getQuerySchema: () => ({
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          status: { type: "string" },
        },
      }),
    };
    const out = schemasOf(resolveOpenApiSchemas(config({ queryParser: queryParser as never })));
    const props = out.listQuery.properties as Record<string, Record<string, unknown>>;
    expect(props.page).toMatchObject({ type: "integer" });
    expect(props.status).toEqual({ type: "string" });
  });

  it("step 5: resource-level maxLimit caps the listQuery limit schema", () => {
    const queryParser = {
      parse: (q: unknown) => q,
      getQuerySchema: () => ({
        type: "object",
        properties: { limit: { type: "integer", minimum: 1 } },
      }),
    };
    const out = schemasOf(
      resolveOpenApiSchemas(config({ queryParser: queryParser as never, maxLimit: 50 })),
    );
    const limit = (out.listQuery.properties as Record<string, Record<string, unknown>>).limit;
    expect(limit.maximum).toBe(50);
  });

  it("step 6: user openApiSchemas overrides merge LAST — they win over everything upstream", () => {
    const out = schemasOf(
      resolveOpenApiSchemas(
        config({
          schemaOptions: { fieldRules: { totalDebit: { systemManaged: true } } },
          openApiSchemas: {
            createBody: { type: "object", required: ["custom"], properties: {} },
          } as never,
        }),
      ),
    );
    expect(out.createBody.required).toEqual(["custom"]);
  });

  it("failure isolation: a throwing adapter degrades to undefined metadata, never throws", () => {
    const throwing = {
      repository: {},
      generateSchemas: () => {
        throw new Error("generator exploded");
      },
    };
    const result = resolveOpenApiSchemas(config({ adapter: throwing as never }));
    expect(result).toBeUndefined(); // resource still boots; docs degrade visibly
  });

  it("adapter without generateSchemas yields metadata with undefined schemas (service resources)", () => {
    const result = resolveOpenApiSchemas(config({ adapter: { repository: {} } as never }));
    expect(result?.openApiSchemas).toBeUndefined();
  });
});
