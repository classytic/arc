/**
 * `dedup: 'handler'` + `owner`: arc only DEMANDS and EXPOSES the key. Keyless -> 400 and the handler
 * never runs; keyed -> the handler runs every time and its response is returned UNMODIFIED; arc adds
 * no store round trip; the route stays declared (registry / route config / OpenAPI); a missing owner
 * refuses at boot. Covers a pipeline custom route, a rawHandler route and an action.
 */
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { buildOpenApiSpec } from "../../src/docs/openapi/index.js";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/stores/memory.js";
import { allowPublic } from "../../src/permissions/index.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";

/** Counts every store command, so "no round trip" is a measurement. */
class CountingStore extends MemoryIdempotencyStore {
  calls = 0;
  override async get(...args: Parameters<MemoryIdempotencyStore["get"]>) {
    this.calls += 1;
    return super.get(...args);
  }
  override async set(...args: Parameters<MemoryIdempotencyStore["set"]>) {
    this.calls += 1;
    return super.set(...args);
  }
  override async tryLock(...args: Parameters<MemoryIdempotencyStore["tryLock"]>) {
    this.calls += 1;
    return super.tryLock(...args);
  }
  override async unlock(...args: Parameters<MemoryIdempotencyStore["unlock"]>) {
    this.calls += 1;
    return super.unlock(...args);
  }
}

const runs = { pipeline: 0, raw: 0, action: 0 };
const OWNER = "web.checkout";

function placement(owner: string | undefined = OWNER) {
  const open = allowPublic();
  const idem = {
    required: true,
    dedup: "handler" as const,
    ...(owner === undefined ? {} : { owner }),
  };
  return defineResource({
    name: "placement",
    prefix: "/placement",
    customRoutesOnly: true,
    routes: [
      {
        method: "POST",
        path: "/pipeline",
        permissions: open,
        config: { idempotency: idem },
        handler: async () => ({ data: { placed: true, idempotent: false, run: ++runs.pipeline } }),
      },
      {
        method: "POST",
        path: "/raw",
        permissions: open,
        config: { idempotency: idem },
        rawHandler: async (request, reply) => {
          reply.code(201).send({ key: request.idempotencyKey, idempotent: true, run: ++runs.raw });
        },
      },
    ],
    actions: {
      place: {
        handler: async () => ({ idempotent: true, run: ++runs.action }),
        permissions: open,
        idempotency: {
          required: true,
          dedup: "handler",
          ...(owner === undefined ? {} : { owner }),
        },
      },
    },
  });
}

let host: FastifyInstance | undefined;
afterEach(async () => {
  await host?.close().catch(() => undefined);
  host = undefined;
  for (const k of Object.keys(runs) as (keyof typeof runs)[]) runs[k] = 0;
});

async function boot(routes?: RouteOptions[]) {
  const store = new CountingStore();
  host = Fastify({ logger: false });
  if (routes) host.addHook("onRoute", (r) => void routes.push(r));
  await host.register(idempotencyPlugin, { enabled: true, store, selfCheck: false });
  await host.register(placement().toPlugin());
  await host.ready();
  store.calls = 0;
  return { app: host, store };
}

const targets = [
  {
    name: "pipeline custom route",
    url: "/placement/pipeline",
    payload: {},
    counter: "pipeline" as const,
  },
  { name: "rawHandler route", url: "/placement/raw", payload: {}, counter: "raw" as const },
  {
    name: "action",
    url: "/placement/a1/action",
    payload: { action: "place" },
    counter: "action" as const,
  },
];

describe("dedup: 'handler'", () => {
  for (const t of targets) {
    it(`${t.name}: keyless 400 (handler not run); keyed runs the handler each time, unmodified, no store call`, async () => {
      const { app, store } = await boot();
      const keyless = await app.inject({ method: "POST", url: t.url, payload: t.payload });
      expect(keyless.statusCode).toBe(400);
      expect(keyless.json().code).toBe("arc.idempotency_key_required");
      expect(runs[t.counter]).toBe(0);

      const call = () =>
        app.inject({
          method: "POST",
          url: t.url,
          headers: { "idempotency-key": "k1" },
          payload: t.payload,
        });
      const first = await call();
      const second = await call();
      expect(first.statusCode).toBeLessThan(300);
      expect(runs[t.counter]).toBe(2);
      expect(second.headers["x-idempotency-replayed"]).toBeUndefined();
      expect(first.headers["x-idempotency-key"]).toBeUndefined();
      expect(second.json()).not.toEqual(first.json());
      expect(store.calls).toBe(0);
    });
  }

  it("the rawHandler sees request.idempotencyKey and its body (idempotent: true) is untouched", async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: "POST",
      url: "/placement/raw",
      headers: { "idempotency-key": "k9" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ key: "k9", idempotent: true });
  });

  it("stays declared: route config, registry and OpenAPI carry required + dedup + owner", async () => {
    const routes: RouteOptions[] = [];
    await boot(routes);
    expect(routes.find((r) => r.url === "/placement/pipeline")?.config?.idempotency).toEqual({
      required: true,
      dedup: "handler",
      owner: OWNER,
    });
    expect(routes.find((r) => r.url === "/placement/:id/action")?.config?.idempotency).toEqual({
      requiredActions: ["place"],
      handlerDedup: { place: OWNER },
    });
    const registry = new ResourceRegistry();
    registry.register(placement());
    const entry = registry.get("placement");
    expect(entry?.customRoutes?.map((r) => r.idempotency)).toEqual([
      { required: true, dedup: "handler", owner: OWNER },
      { required: true, dedup: "handler", owner: OWNER },
    ]);
    expect(entry?.actions?.[0]?.idempotency).toEqual({
      required: true,
      dedup: "handler",
      owner: OWNER,
    });
    const spec = buildOpenApiSpec(entry ? [entry] : []);
    expect(spec.paths["/placement/pipeline"]?.post?.["x-arc-idempotency"]).toEqual({
      required: true,
      dedup: "handler",
      owner: OWNER,
    });
    expect(spec.paths["/placement/{id}/action"]?.post?.["x-arc-idempotency"]).toEqual({
      requiredActions: ["place"],
      handlerDedup: { place: OWNER },
    });
  });

  it("boot refuses dedup: 'handler' without a non-empty owner (route and action)", async () => {
    for (const owner of ["", "  "]) {
      const app = Fastify({ logger: false });
      await app.register(idempotencyPlugin, { enabled: true });
      await expect(
        (async () => {
          await app.register(placement(owner).toPlugin());
          await app.ready();
        })(),
      ).rejects.toThrow(/owner/);
      await app.close().catch(() => undefined);
    }
  });

  it("boot refuses dedup: 'handler' without required: true", async () => {
    const app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, { enabled: true });
    expect(() =>
      app.post(
        "/x",
        { config: { idempotency: { dedup: "handler", owner: OWNER } } },
        async () => ({}),
      ),
    ).toThrow(/needs required: true/);
    await app.close().catch(() => undefined);
  });
});
