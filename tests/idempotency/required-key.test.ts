/**
 * `config.idempotency.required` — a route whose retry must not execute twice refuses a call
 * with no idempotency key (400), instead of silently running it unprotected.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { allowPublic } from "../../src/permissions/index.js";

let app: FastifyInstance;
let runs = 0;

beforeEach(async () => {
  runs = 0;
  app = Fastify({ logger: false });
  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
  app.post(
    "/checkout",
    { config: { idempotency: { required: true } }, preHandler: [app.idempotency.middleware] },
    async () => ({ run: ++runs }),
  );
  app.post("/note", { preHandler: [app.idempotency.middleware] }, async () => ({ run: ++runs }));
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe("required idempotency keys", () => {
  it("refuses a keyless call to a route that requires one — the handler never runs", async () => {
    const res = await app.inject({ method: "POST", url: "/checkout", payload: { total: 1 } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code?: string }).code).toBe("arc.idempotency_key_required");
    expect(runs).toBe(0);
  });

  it("runs a keyed call once and replays its retry", async () => {
    const call = () =>
      app.inject({
        method: "POST",
        url: "/checkout",
        headers: { "idempotency-key": "k" },
        payload: { total: 1 },
      });
    expect((await call()).json()).toEqual({ run: 1 });
    expect((await call()).json()).toEqual({ run: 1 });
    expect(runs).toBe(1);
  });

  it("leaves routes that do not declare it optional", async () => {
    const res = await app.inject({ method: "POST", url: "/note", payload: { text: "x" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("required idempotency keys — DELETE and arc-built routes", () => {
  const deleteResource = (counter: { runs: number }) =>
    defineResource({
      name: "ledger",
      prefix: "/ledger",
      customRoutesOnly: true,
      routes: [
        {
          method: "DELETE",
          path: "/:id/void",
          permissions: allowPublic(),
          config: { idempotency: { required: true } },
          handler: async () => ({ run: ++counter.runs }),
        },
        {
          method: "DELETE",
          path: "/:id/draft",
          permissions: allowPublic(),
          handler: async () => ({ run: ++counter.runs }),
        },
      ],
    });

  it("fences a DELETE that declares it — keyless is 400, a keyed retry replays", async () => {
    const counter = { runs: 0 };
    const host = Fastify({ logger: false });
    // Default `methods` omits DELETE: the route's declaration must win anyway.
    await host.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
    await host.register(deleteResource(counter).toPlugin());
    try {
      const keyless = await host.inject({ method: "DELETE", url: "/ledger/7/void" });
      expect(keyless.statusCode).toBe(400);
      expect((keyless.json() as { code?: string }).code).toBe("arc.idempotency_key_required");
      expect(counter.runs).toBe(0);

      const keyed = () =>
        host.inject({
          method: "DELETE",
          url: "/ledger/7/void",
          headers: { "idempotency-key": "v1" },
        });
      expect((await keyed()).json()).toEqual({ run: 1 });
      const retry = await keyed();
      expect(retry.json()).toEqual({ run: 1 });
      expect(retry.headers["x-idempotency-replayed"]).toBe("true");
      expect(counter.runs).toBe(1);

      // An undeclared DELETE behaves as before: no key needed, a key is not honoured.
      const draft = () =>
        host.inject({
          method: "DELETE",
          url: "/ledger/7/draft",
          headers: { "idempotency-key": "d1" },
        });
      expect((await draft()).json()).toEqual({ run: 2 });
      expect((await draft()).json()).toEqual({ run: 3 });
    } finally {
      await host.close();
    }
  });

  it("a declared route ignores the plugin's `exclude` patterns — specific beats general", async () => {
    let runs = 0;
    const host = Fastify({ logger: false });
    await host.register(idempotencyPlugin, { enabled: true, exclude: [/^\/pay/] });
    host.post(
      "/pay",
      { config: { idempotency: { required: true } }, preHandler: [host.idempotency.middleware] },
      async () => ({ run: ++runs }),
    );
    try {
      expect((await host.inject({ method: "POST", url: "/pay" })).statusCode).toBe(400);
      const call = () =>
        host.inject({ method: "POST", url: "/pay", headers: { "idempotency-key": "p" } });
      expect((await call()).json()).toEqual({ run: 1 });
      expect((await call()).json()).toEqual({ run: 1 });
    } finally {
      await host.close();
    }
  });
});

describe("required idempotency keys — arc rawHandler route", () => {
  it("boots, refuses keyless, and dedupes a keyed retry on a rawHandler custom route", async () => {
    let runs = 0;
    const host = Fastify({ logger: false });
    await host.register(idempotencyPlugin, { enabled: true });
    await host.register(
      defineResource({
        name: "po",
        prefix: "/po",
        customRoutesOnly: true,
        routes: [
          {
            method: "POST",
            path: "/composite",
            permissions: allowPublic(),
            config: { idempotency: { required: true } },
            rawHandler: async (_req, reply) => reply.code(201).send({ run: ++runs }),
          },
        ],
      }).toPlugin(),
    );
    try {
      const keyless = await host.inject({ method: "POST", url: "/po/composite", payload: {} });
      expect(keyless.statusCode).toBe(400);
      expect((keyless.json() as { code?: string }).code).toBe("arc.idempotency_key_required");
      const keyed = () =>
        host.inject({
          method: "POST",
          url: "/po/composite",
          headers: { "idempotency-key": "c1" },
          payload: {},
        });
      expect((await keyed()).json()).toEqual({ run: 1 });
      expect((await keyed()).json()).toEqual({ run: 1 });
      expect(runs).toBe(1);
    } finally {
      await host.close();
    }
  });
});

describe("required idempotency keys — boot refuses a declaration nothing enforces", () => {
  it("refuses a declared route when the plugin is disabled", async () => {
    const host = Fastify({ logger: false });
    await host.register(idempotencyPlugin, { enabled: false });
    expect(() =>
      host.post("/pay", { config: { idempotency: { required: true } } }, async () => ({})),
    ).toThrow(/declares config\.idempotency\.required, but the idempotency plugin is disabled/);
    await host.close();
  });

  it("refuses a declared host route whose preHandler does not run the middleware", async () => {
    const host = Fastify({ logger: false });
    await host.register(idempotencyPlugin, { enabled: true });
    expect(() =>
      host.post("/pay", { config: { idempotency: { required: true } } }, async () => ({})),
    ).toThrow(/preHandler does not run fastify\.idempotency\.middleware/);
    await host.close();
  });

  it("refuses a declared arc route when no idempotency plugin is registered", async () => {
    const host = Fastify({ logger: false });
    await expect(host.register(deleteResourceWithoutCounter().toPlugin()).ready()).rejects.toThrow(
      /declares config\.idempotency\.required, but idempotencyPlugin is not registered/,
    );
    await host.close();
  });
});

function deleteResourceWithoutCounter() {
  return defineResource({
    name: "ledger",
    prefix: "/ledger",
    customRoutesOnly: true,
    routes: [
      {
        method: "DELETE",
        path: "/:id/void",
        permissions: allowPublic(),
        config: { idempotency: { required: true } },
        handler: async () => ({ ok: true }),
      },
    ],
  });
}
