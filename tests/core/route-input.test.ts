/**
 * routeInput / crudInput / ActionDefinition.parse: one zod declaration, three consumers
 * (AJV, parsed handler input, docs), plus detection of `{ body: X }` wrappers.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "../../src/core/defineAction.js";
import {
  collectSchemaSlotDiagnostics,
  findSlotWrapper,
} from "../../src/core/defineResource/schemaDiagnostics.js";
import { defineResource } from "../../src/core/defineResource.js";
import { crudInput, noPayloadSchema, parsed, routeInput } from "../../src/core/routeInput.js";
import { openApiPlugin } from "../../src/docs/openapi.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

const adapter = () =>
  ({
    type: "mock",
    name: "mock",
    repository: {
      create: async (data: Record<string, unknown>) => ({ _id: "1", ...data }),
      update: async (_id: string, data: Record<string, unknown>) => ({ _id: "1", ...data }),
      getAll: async () => ({ data: [], total: 0 }),
      getById: async () => null,
    },
  }) as never;

const gated = {
  list: allowPublic(),
  get: allowPublic(),
  create: allowPublic(),
  update: allowPublic(),
  delete: allowPublic(),
};

let app: FastifyInstance;
afterEach(async () => {
  await app?.close().catch(() => {});
});

const echoBody = z.object({
  title: z.string().trim().min(2),
  status: z.string().default("draft"),
  tags: z.array(z.string()).default([]),
});
const query = z.object({ limit: z.coerce.number().int().min(1).default(10) });

async function build(extra: Record<string, unknown> = {}) {
  const resource = defineResource({
    name: "gadget",
    adapter: adapter(),
    permissions: gated,
    ...extra,
    routes: [
      {
        method: "POST",
        path: "/echo",
        permissions: allowPublic(),
        ...routeInput({ body: echoBody, querystring: query }),
        rawHandler: async (req, reply) =>
          reply.send({ body: parsed(echoBody, req.body), query: parsed(query, req.query) }),
      },
      {
        method: "POST",
        path: "/plain",
        permissions: allowPublic(),
        ...routeInput({
          body: { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        }),
        rawHandler: async (req, reply) => reply.send({ body: req.body }),
      },
    ],
  });
  app = await createApp({
    logger: false,
    preset: "testing",
    auth: false,
    resources: [resource],
    plugins: async (f) => {
      await f.register(openApiPlugin, { title: "t", version: "1" });
    },
  });
  return app;
}

describe("routeInput: slots", () => {
  it("returns no preHandler without a zod slot", () => {
    expect(routeInput({ response: { 200: z.object({}) } }).preHandler).toEqual([]);
    expect(routeInput({ body: { type: "object" } }).preHandler).toEqual([]);
    expect(routeInput({ body: echoBody }).preHandler).toHaveLength(1);
  });

  it("AJV rejects what JSON Schema can express: 400 arc.validation_error", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/gadgets/echo", payload: { title: 5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
  });

  it("the preHandler hands the handler the zod OUTPUT: trim, defaults, coercion", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/gadgets/echo?limit=3",
      payload: { title: "  hello  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      body: { title: "hello", status: "draft", tags: [] },
      query: { limit: 3 },
    });
  });

  it("a refinement JSON Schema cannot express fails the parse as a 400 with field details", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/gadgets/echo",
      payload: { title: " a " },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("arc.validation_error");
    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "title" })]),
    );
  });

  it("a plain JSON Schema slot is validated by AJV only", async () => {
    await build();
    const bad = await app.inject({ method: "POST", url: "/gadgets/plain", payload: {} });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/gadgets/plain", payload: { a: "x" } });
    expect(ok.json()).toEqual({ body: { a: "x" } });
  });
});

describe("input vs output direction", () => {
  it("a .default() field is optional on the wire (input), in the request AND in the docs", async () => {
    await build();
    const ok = await app.inject({
      method: "POST",
      url: "/gadgets/echo",
      payload: { title: "ok" },
    });
    expect(ok.statusCode).toBe(200);
    const spec = (await app.inject({ method: "GET", url: "/_docs/openapi.json" })).json();
    const body = spec.paths["/gadgets/echo"].post.requestBody.content["application/json"].schema;
    expect(body.required).toEqual(["title"]);
    expect(body.properties.status).toBeDefined();
  });
});

describe("OpenAPI derives from crudInput", () => {
  it("documents the CRUD write body as the zod contract, not the stored model", async () => {
    const create = z.strictObject({ name: z.string(), rank: z.number().default(1) });
    await build(crudInput({ create }));
    const spec = (await app.inject({ method: "GET", url: "/_docs/openapi.json" })).json();
    const ref = spec.paths["/gadgets"].post.requestBody.content["application/json"].schema.$ref;
    const schema = spec.components.schemas[String(ref).split("/").pop() as string];
    expect(schema.required).toEqual(["name"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["name", "rank"]);
  });
});

describe("crudInput", () => {
  const create = z.object({ name: z.string().trim().min(1), rank: z.number().default(7) });

  it("without parse: customSchemas + openApiSchemas only", () => {
    const out = crudInput({ create });
    expect(out.customSchemas.create).toEqual({ body: create });
    expect(out.openApiSchemas.createBody).toBe(create);
    expect(out.middlewares).toEqual({});
  });

  it("with parse: create body reaches the repository as the zod output", async () => {
    await build(crudInput({ create, parse: true }));
    const res = await app.inject({ method: "POST", url: "/gadgets", payload: { name: "  x " } });
    expect(res.statusCode).toBe(201);
    expect(JSON.stringify(res.json())).toContain('"name":"x"');
    expect(JSON.stringify(res.json())).toContain('"rank":7');
  });

  it("AJV rejects a missing required field", async () => {
    await build(crudInput({ create }));
    const res = await app.inject({ method: "POST", url: "/gadgets", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("ActionDefinition.parse / defineAction({ parse: true })", () => {
  const schema = z.object({ note: z.string().trim().min(2), urgent: z.boolean().default(false) });

  async function withAction(parse: boolean | undefined) {
    let seen: unknown;
    app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resources: [
        defineResource({
          name: "ticket",
          adapter: adapter(),
          permissions: gated,
          actions: {
            close: defineAction({
              schema,
              ...(parse === undefined ? {} : { parse }),
              permissions: allowPublic(),
              handler: async (_id, data) => {
                seen = data;
                return { ok: true };
              },
            }),
          },
        }),
      ],
    });
    return () => seen;
  }

  it("parse: true gives the handler trimmed + defaulted data", async () => {
    const seen = await withAction(true);
    const res = await app.inject({
      method: "POST",
      url: "/tickets/1/action",
      payload: { action: "close", note: "  done " },
    });
    expect(res.statusCode).toBe(200);
    expect(seen()).toEqual({ note: "done", urgent: false });
  });

  it("parse: true turns a refinement failure into a 400, not a 500", async () => {
    await withAction(true);
    const res = await app.inject({
      method: "POST",
      url: "/tickets/1/action",
      payload: { action: "close", note: " a " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
  });

  it("default (no parse): the handler sees what AJV accepted, untouched", async () => {
    const seen = await withAction(undefined);
    await app.inject({
      method: "POST",
      url: "/tickets/1/action",
      payload: { action: "close", note: "  done " },
    });
    expect((seen() as { note: string }).note).toBe("  done "); // not trimmed: no zod parse
  });

  it("noPayloadSchema: AJV refuses a stray field", async () => {
    app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resources: [
        defineResource({
          name: "ticket",
          adapter: adapter(),
          permissions: gated,
          actions: {
            ping: {
              schema: noPayloadSchema,
              permissions: allowPublic(),
              handler: async () => ({ pong: true }),
            },
          },
        }),
      ],
    });
    const stray = await app.inject({
      method: "POST",
      url: "/tickets/1/action",
      payload: { action: "ping", extra: 1 },
    });
    expect(stray.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/tickets/1/action",
      payload: { action: "ping" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("`{ body: X }` wrapper misuse", () => {
  const wrapperAction = () => ({
    close: {
      schema: { body: z.object({ note: z.string() }) },
      permissions: allowPublic(),
      handler: async () => ({ ok: true }),
    },
  });

  it("findSlotWrapper tells wrappers from schemas", () => {
    expect(findSlotWrapper({ body: { type: "object" } })).toEqual(["body"]);
    expect(findSlotWrapper(z.object({ body: z.string() }))).toEqual([]);
    expect(findSlotWrapper({ type: "object", properties: { body: { type: "string" } } })).toEqual(
      [],
    );
    expect(findSlotWrapper({ $ref: "#/x" })).toEqual([]);
    expect(findSlotWrapper({})).toEqual([]);
    expect(findSlotWrapper(undefined)).toEqual([]);
  });

  it("warns at registration for an action wrapper, and the action really is unvalidated", async () => {
    const warnings: string[] = [];
    app = await createApp({
      logger: { level: "warn", stream: { write: (l: string) => void warnings.push(l) } },
      preset: "testing",
      auth: false,
      resources: [
        defineResource({
          name: "ticket",
          adapter: adapter(),
          permissions: gated,
          actions: wrapperAction(),
        }),
      ],
    });
    expect(warnings.join("\n")).toContain("action 'close' schema is a `{ body }` wrapper");
    // The failure the warning exists for: any body passes.
    const res = await app.inject({
      method: "POST",
      url: "/tickets/1/action",
      payload: { action: "close", note: 42, junk: true },
    });
    expect(res.statusCode).toBe(200);
  });

  it("strictSchemas: true throws at defineResource() naming the action and the fix", () => {
    expect(() =>
      defineResource({
        name: "ticket",
        adapter: adapter(),
        permissions: gated,
        strictSchemas: true,
        actions: wrapperAction(),
      }),
    ).toThrow(/action 'close' schema is a `\{ body \}` wrapper[\s\S]*pass the schema directly/);
  });

  it("covers route slots and customSchemas too", () => {
    const wrapped = { body: { type: "object" } };
    const diags = collectSchemaSlotDiagnostics(
      {
        name: "r",
        routes: [{ method: "POST", path: "/x", schema: { body: wrapped } }],
        customSchemas: { create: { body: wrapped, params: { type: "object" } } },
      },
      false,
    );
    expect(diags.map((d) => d.code)).toEqual(["schema.slot_wrapper", "schema.slot_wrapper"]);
    expect(diags[0]?.message).toContain("route POST /x schema.body");
    expect(diags[1]?.message).toContain("customSchemas.create.body");
    expect(
      collectSchemaSlotDiagnostics(
        { name: "r", routes: [{ schema: { body: { type: "object" } } }] },
        true,
      ),
    ).toEqual([]);
  });

  it("a correct action schema raises nothing, even under strictSchemas", () => {
    const r = defineResource({
      name: "ticket",
      adapter: adapter(),
      permissions: gated,
      strictSchemas: true,
      actions: {
        close: {
          schema: z.object({ note: z.string() }),
          permissions: allowPublic(),
          handler: async () => 1,
        },
      },
    });
    expect(r._diagnostics ?? []).toEqual([]);
  });
});
