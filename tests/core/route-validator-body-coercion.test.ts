/**
 * Type coercion is for URL parts only. A JSON body is already typed; coercing it rewrites a value
 * by the FIRST matching `anyOf` branch, so `{ value: false }` against
 * `anyOf [number, boolean, string]` reached the handler as `0` (FLOW OCC checklist yes/no answers
 * could not be submitted). Query, params and headers still coerce; `ajv.coerceBody` opts back in.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

const unionBody = {
  type: "object",
  properties: {
    value: { anyOf: [{ type: "number" }, { type: "boolean" }, { type: "string" }] },
    count: { type: "number" },
  },
  required: ["value"],
} as const;

function answerResource() {
  return defineResource({
    name: "answer",
    prefix: "/answers",
    customRoutesOnly: true,
    routes: [
      {
        method: "POST",
        path: "/submit",
        permissions: allowPublic(),
        schema: { body: unionBody },
        handler: async (req) => ({ received: req.body }),
      },
      {
        method: "GET",
        path: "/items/:n",
        permissions: allowPublic(),
        schema: {
          params: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
          querystring: {
            type: "object",
            properties: { limit: { type: "integer" }, active: { type: "boolean" } },
          },
          headers: {
            type: "object",
            properties: { "X-Page": { type: "integer" } },
            required: ["X-Page"],
          },
        },
        handler: async (req) => ({
          params: req.params,
          query: req.query,
          page: req.headers["x-page"],
        }),
      },
    ],
  });
}

async function arcHost(coerceBody?: boolean): Promise<FastifyInstance> {
  return createApp({
    preset: "testing",
    auth: false,
    logger: false,
    ...(coerceBody !== undefined ? { ajv: { coerceBody } } : {}),
    resources: [answerResource()],
  });
}

async function bareHost(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(answerResource().toPlugin());
  await app.ready();
  return app;
}

const hosts: Array<[string, () => Promise<FastifyInstance>]> = [
  ["createApp", () => arcHost()],
  ["bare Fastify host", bareHost],
];

describe.each(hosts)("body vs URL coercion (%s)", (_label, build) => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([false, true])(
    "keeps a boolean body value (%s) under anyOf[number, boolean, string]",
    async (value) => {
      app = await build();
      const res = await app.inject({ method: "POST", url: "/answers/submit", payload: { value } });
      expect(res.statusCode).toBe(200);
      expect(res.json().received.value).toBe(value);
    },
  );

  it("keeps a numeric and a string body value as sent", async () => {
    app = await build();
    const num = await app.inject({ method: "POST", url: "/answers/submit", payload: { value: 3 } });
    expect(num.json().received.value).toBe(3);
    const str = await app.inject({
      method: "POST",
      url: "/answers/submit",
      payload: { value: "5" },
    });
    expect(str.json().received.value).toBe("5");
  });

  it("rejects a string where the body schema wants a number", async () => {
    app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/answers/submit",
      payload: { value: 1, count: "5" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("still coerces querystring, params and headers", async () => {
    app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/answers/items/7?limit=5&active=true",
      headers: { "x-page": "2" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.params.n).toBe(7);
    expect(body.query.limit).toBe(5);
    expect(body.query.active).toBe(true);
    expect(body.page).toBe(2);
  });
});

describe("createApp({ ajv: { coerceBody: true } })", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("re-enables body coercion as an explicit opt-in", async () => {
    app = await arcHost(true);
    const res = await app.inject({
      method: "POST",
      url: "/answers/submit",
      payload: { value: 1, count: "5" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().received.count).toBe(5);
  });
});
