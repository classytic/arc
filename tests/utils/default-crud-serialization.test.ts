/**
 * Default CRUD serialization — a resource with no response schema.
 *
 * Rows and single documents default to the `{}` schema, which fast-json-stringify
 * hands to `JSON.stringify`. The previous `{ type: 'object', additionalProperties:
 * true }` produced the same bytes ~3.5x slower (every key of every row through
 * fjs's generic path) and filtered nothing. This pins that the switch is
 * byte-identical on the payloads that differ between serializers.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, defineResource } from "../../src/index.js";
import { getDefaultCrudSchemas } from "../../src/utils/responseSchemas.js";

class ObjectIdLike {
  constructor(private readonly hex: string) {}
  toJSON() {
    return this.hex;
  }
}

const tricky = () => ({
  _id: new ObjectIdLike("507f1f77bcf86cd799439011"),
  name: 'quo"te   é',
  createdAt: new Date(0),
  nested: { a: [1, { b: null }], gone: undefined },
  gone: undefined,
  nan: Number.NaN,
  big: 1e21,
  arr: [undefined, () => 1],
  custom: { toJSON: () => ({ x: 1 }) },
  "": "empty key",
});

describe("default CRUD serialization", () => {
  it("rows and single documents default to the pass-through schema", () => {
    const schemas = getDefaultCrudSchemas() as Record<
      string,
      { response: Record<string, unknown> }
    >;
    const list = schemas.list?.response[200] as { properties: { data: { items: unknown } } };
    expect(list.properties.data.items).toEqual({});
    expect(schemas.get?.response[200]).toEqual({});
  });

  it("is byte-identical to the old open-object schema and to JSON.stringify", async () => {
    // Through Fastify's own serializer compiler — the path arc routes use.
    const app = Fastify({ logger: false });
    const docs = [tricky(), {}, { toJSON: () => ({ replaced: true }) }];
    const route = (url: string, schema: object) =>
      app.get(url, { schema: { response: { 200: schema } } }, async (req) => {
        return docs[Number((req.query as { i: string }).i)];
      });
    route("/old", { type: "object", additionalProperties: true });
    route("/new", {});
    for (let i = 0; i < docs.length; i++) {
      const oldBody = (await app.inject({ url: `/old?i=${i}` })).body;
      const newBody = (await app.inject({ url: `/new?i=${i}` })).body;
      expect(newBody).toBe(oldBody);
      expect(newBody).toBe(JSON.stringify(docs[i]));
    }
    await app.close();
  });

  it("serves the same body end to end", async () => {
    const rows = [tricky(), tricky()];
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resources: [
        defineResource({
          name: "item",
          adapter: {
            type: "custom",
            repository: {
              getAll: async () => ({
                method: "offset",
                data: rows,
                page: 1,
                limit: 20,
                total: 2,
                pages: 1,
              }),
              getById: async () => rows[0],
            },
          },
          permissions: { list: allowPublic(), get: allowPublic() },
          disabledRoutes: ["create", "update", "delete"],
        }),
      ],
    });
    const list = await app.inject({ method: "GET", url: "/items" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(JSON.parse(JSON.stringify(rows)));

    const one = await app.inject({ method: "GET", url: "/items/507f1f77bcf86cd799439011" });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual(JSON.parse(JSON.stringify(rows[0])));
    await app.close();
  });
});
