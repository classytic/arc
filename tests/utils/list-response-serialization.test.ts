/**
 * listResponse serializer contract (2.22)
 *
 * The default CRUD list route's `response: { 200 }` schema previously used
 * a top-level `oneOf` of the four canonical list variants. fast-json-
 * stringify handles `oneOf` by running full AJV validation per response to
 * pick a branch — on the hottest route in every arc app. The merged
 * single-shape schema serializes every variant identically (all four were
 * `additionalProperties: true` supersets of one permissive object) without
 * per-response branch validation.
 *
 * These tests pin the WIRE BYTES of all four canonical variants through a
 * live Fastify serializer so the schema change is provably behavior-
 * preserving.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { listResponse } from "../../src/utils/responseSchemas.js";

const itemSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  additionalProperties: true,
};

const VARIANTS: Record<string, Record<string, unknown>> = {
  offset: {
    method: "offset",
    data: [{ name: "a", extra: 1 }],
    page: 1,
    limit: 20,
    total: 1,
    pages: 1,
    hasNext: false,
    hasPrev: false,
  },
  keyset: {
    method: "keyset",
    data: [{ name: "b" }],
    limit: 20,
    hasMore: true,
    next: "cursor-token",
  },
  keysetEnd: {
    method: "keyset",
    data: [],
    limit: 20,
    hasMore: false,
    next: null,
  },
  aggregate: {
    method: "aggregate",
    data: [{ name: "c" }],
    page: 2,
    limit: 10,
    total: 25,
    pages: 3,
    hasNext: true,
    hasPrev: true,
  },
  bare: {
    data: [{ name: "d" }],
  },
};

describe("listResponse — single-shape serializer, wire-compatible for all variants", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function makeApp() {
    app = Fastify({ logger: false });
    for (const [name, payload] of Object.entries(VARIANTS)) {
      app.get(`/${name}`, { schema: { response: { 200: listResponse(itemSchema) } } }, async () => {
        // structuredClone so the serializer can't mutate the fixture.
        return structuredClone(payload);
      });
    }
    await app.ready();
    return app;
  }

  for (const [name, payload] of Object.entries(VARIANTS)) {
    it(`serializes the ${name} variant byte-for-byte (all declared fields survive)`, async () => {
      await makeApp();
      const res = await app.inject({ method: "GET", url: `/${name}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(payload);
    });
  }

  it("does NOT use a top-level oneOf (fast-json-stringify branch validation)", () => {
    const schema = listResponse(itemSchema) as Record<string, unknown>;
    expect(schema.oneOf).toBeUndefined();
    expect(schema.type).toBe("object");
  });

  it("keeps additionalProperties passthrough (kit-specific extra fields survive)", async () => {
    await makeApp();
    const res = await app.inject({ method: "GET", url: "/offset" });
    expect(res.json().data[0].extra).toBe(1);
  });
});
