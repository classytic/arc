import { describe, expect, it } from "vitest";
import {
  ArcDeleteResponse,
  ArcErrorResponse,
  ArcListResponse,
  ArcPaginationQuery,
  Type,
} from "../../src/schemas/index.js";

// No-envelope contract: schemas describe the canonical wire shape directly.
//   - ArcListResponse → { method?, data: T[], page?, limit?, total?, ... } (paginated/bare list)
//   - Single-doc responses (get / create / update) — pass the schema directly,
//     there is no helper. Pre-2.13 ArcItemResponse / ArcMutationResponse were
//     identity functions; deleted in the cleanup.
//   - ArcDeleteResponse → { message, id?, soft? } raw at the top level
//   - ArcErrorResponse → canonical ErrorContract { code, message, status, ... }

describe("ArcListResponse()", () => {
  it("describes the canonical paginated wire shape — full union, no envelope", () => {
    // 2.13: ArcListResponse() now models the FULL union toCanonicalList
    // emits (offset / keyset / aggregate / bare). Pre-2.13 it modelled
    // only offset, which silently rejected valid keyset / bare responses
    // at the response-validation gate. Per-shape helpers
    // (ArcOffsetListResponse / ArcKeysetListResponse /
    // ArcAggregateListResponse / ArcBareListResponse) pin a single
    // variant when needed.
    const schema = ArcListResponse(Type.Object({ name: Type.String() })) as {
      anyOf?: Array<{ properties?: Record<string, { const?: string }> }>;
    };
    expect(schema.anyOf).toBeDefined();
    expect(schema.anyOf).toHaveLength(4);

    // Every branch carries a `data` array; no `success` field anywhere.
    for (const branch of schema.anyOf ?? []) {
      expect(branch.properties).toHaveProperty("data");
      expect(branch.properties).not.toHaveProperty("success");
    }

    // Branches discriminate via `method` (or its absence for the bare list).
    const methods = (schema.anyOf ?? [])
      .map((b) => b.properties?.method?.const)
      .sort((a, b) => String(a).localeCompare(String(b)));
    expect(methods).toEqual(["aggregate", "keyset", "offset", undefined]);
  });
});

// Single-doc responses (`get` / `create` / `update`) intentionally have NO
// helper — the doc IS the response (no envelope; HTTP status discriminates).
// Hosts pass their TypeBox schema directly to `response: { 200: schema }`.
// This test pins that contract: a plain Type.Object describes the wire shape,
// no wrapper required.
describe("Single-doc response (no helper)", () => {
  it("a plain TypeBox object IS the wire shape — no wrapper needed", () => {
    const schema = Type.Object({ id: Type.String() }) as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("id");
    expect(schema.properties).not.toHaveProperty("success");
    expect(schema.properties).not.toHaveProperty("data");
  });
});

describe("ArcDeleteResponse()", () => {
  it("describes the raw delete payload { message, id?, soft? }", () => {
    const schema = ArcDeleteResponse();
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("message");
    expect(schema.properties).toHaveProperty("id");
    expect(schema.properties).toHaveProperty("soft");
    expect(schema.properties).not.toHaveProperty("success");
  });
});

describe("ArcErrorResponse()", () => {
  it("describes the canonical ErrorContract { code, message, status, ... }", () => {
    const schema = ArcErrorResponse();
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("code");
    expect(schema.properties).toHaveProperty("message");
    expect(schema.properties).toHaveProperty("status");
    expect(schema.properties).not.toHaveProperty("success");
    expect(schema.properties).not.toHaveProperty("error");
  });
});

describe("ArcPaginationQuery()", () => {
  it("returns a schema with page, limit, sort, select params", () => {
    const schema = ArcPaginationQuery();
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("page");
    expect(schema.properties).toHaveProperty("limit");
    expect(schema.properties).toHaveProperty("sort");
    expect(schema.properties).toHaveProperty("select");
  });
});
