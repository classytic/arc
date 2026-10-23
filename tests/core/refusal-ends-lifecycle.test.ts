/**
 * A refusal must end the request lifecycle deterministically. Fastify decides whether to run
 * the handler by checking `reply.sent` after an async hook resolves; with two or more async
 * `preSerialization`/`onSend` hooks in scope the write is deferred, `reply.sent` is still
 * false, and a gate that only called `reply.send(...)` let the handler run after the 403.
 *
 * For 0, 1 and 3 async hooks of each kind: a refused CRUD write, action and custom route
 * answers 403/401 and never reaches the handler or repository.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../src/core/aggregation/index.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { defineGuard } from "../../src/utils/defineGuard.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";
const admin = requireRoles(["admin"]);

const work = {
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  action: vi.fn(),
  custom: vi.fn(),
  aggregation: vi.fn(),
};

interface Doc {
  _id: string;
}

const adapter: DataAdapter<Doc> = {
  type: "custom",
  name: "refusal-stub",
  repository: {
    create: async (data) => {
      work.create(data);
      return { _id: "doc-1", ...data };
    },
    getById: async (id) => ({ _id: id }),
    getAll: async () => [],
    update: async (id, data) => {
      work.update(id);
      return { _id: id, ...data };
    },
    delete: async () => {
      work.remove();
      return { success: true };
    },
  },
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  for (const fn of Object.values(work)) fn.mockClear();
});

async function boot(phase: "preSerialization" | "onSend", hooks: number): Promise<FastifyInstance> {
  const resource = defineResource({
    name: "gate",
    adapter,
    permissions: { list: admin, get: admin, create: admin, update: admin, delete: admin },
    routes: [
      {
        method: "POST",
        path: "/custom",
        permissions: admin,
        handler: async () => {
          work.custom();
          return { ok: true };
        },
      },
    ],
    aggregations: {
      summary: defineAggregation({
        measures: { count: "count" },
        permissions: admin,
        materialized: async () => {
          work.aggregation();
          return { rows: [{ count: 1 }] };
        },
      }),
    },
    actions: {
      adjust: {
        handler: async () => {
          work.action();
          return { ok: true };
        },
        permissions: admin,
      },
    },
  });
  app = await createApp({
    logger: false,
    preset: "testing",
    auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
    plugins: async (f) => {
      for (let i = 0; i < hooks; i++) {
        if (phase === "preSerialization") {
          f.addHook("preSerialization", async (_req, _reply, payload) => {
            await tick();
            return payload;
          });
        } else {
          f.addHook("onSend", async (_req, _reply, payload) => {
            await tick();
            return payload;
          });
        }
      }
      await f.register(resource.toPlugin());
    },
  });
  await app.ready();
  return app;
}

function bearer(role: string): Record<string, string> {
  const auth: { issueTokens: (p: Record<string, unknown>) => { accessToken: string } } =
    Reflect.get(app ?? {}, "auth");
  return {
    authorization: `Bearer ${auth.issueTokens({ id: `u-${role}`, role: [role] }).accessToken}`,
  };
}

const attempts = [
  { kind: "CRUD create", method: "POST", url: "/gates", payload: {}, spy: "create" },
  { kind: "CRUD update", method: "PATCH", url: "/gates/doc-1", payload: {}, spy: "update" },
  { kind: "CRUD delete", method: "DELETE", url: "/gates/doc-1", payload: undefined, spy: "remove" },
  {
    kind: "action",
    method: "POST",
    url: "/gates/doc-1/action",
    payload: { action: "adjust" },
    spy: "action",
  },
  { kind: "custom route", method: "POST", url: "/gates/custom", payload: {}, spy: "custom" },
  {
    kind: "aggregation",
    method: "GET",
    url: "/gates/aggregations/summary",
    payload: undefined,
    spy: "aggregation",
  },
] as const;

describe("refusal ends the lifecycle (async send-phase hooks)", () => {
  for (const phase of ["preSerialization", "onSend"] as const) {
    for (const hooks of [0, 1, 3]) {
      describe(`${hooks} async ${phase} hook(s)`, () => {
        for (const attempt of attempts) {
          it(`${attempt.kind}: unprivileged -> 403, no work`, async () => {
            const server = await boot(phase, hooks);
            const res = await server.inject({
              method: attempt.method,
              url: attempt.url,
              headers: bearer("member"),
              ...(attempt.payload ? { payload: attempt.payload } : {}),
            });
            expect(res.statusCode).toBe(403);
            await tick();
            expect(work[attempt.spy]).not.toHaveBeenCalled();
          });

          it(`${attempt.kind}: anonymous -> 401, no work`, async () => {
            const server = await boot(phase, hooks);
            const res = await server.inject({
              method: attempt.method,
              url: attempt.url,
              ...(attempt.payload ? { payload: attempt.payload } : {}),
            });
            expect(res.statusCode).toBe(401);
            await tick();
            expect(work[attempt.spy]).not.toHaveBeenCalled();
          });
        }
      });
    }
  }

  it("an allowed caller still reaches the handler with 3 async hooks", async () => {
    const server = await boot("onSend", 3);
    const res = await server.inject({
      method: "POST",
      url: "/gates/doc-1/action",
      headers: bearer("admin"),
      payload: { action: "adjust" },
    });
    expect(res.statusCode).toBe(200);
    expect(work.action).toHaveBeenCalledTimes(1);
  });
});

describe("host-supplied refusals end the lifecycle (async send-phase hooks)", () => {
  it("a custom authenticator that replies 401 and returns nothing never reaches the handler", async () => {
    const resource = defineResource({
      name: "gate",
      adapter,
      permissions: { list: admin, get: admin, create: admin, update: admin, delete: admin },
    });
    app = await createApp({
      logger: false,
      preset: "testing",
      auth: {
        type: "authenticator",
        authenticate: async (_request, reply) => {
          reply.code(401).send({ code: "arc.unauthorized", message: "no", status: 401 });
        },
      },
      plugins: async (f) => {
        for (let i = 0; i < 3; i++) {
          f.addHook("onSend", async (_req, _reply, payload) => {
            await tick();
            return payload;
          });
        }
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/gates", payload: {} });
    expect(res.statusCode).toBe(401);
    await tick();
    expect(work.create).not.toHaveBeenCalled();
  });

  it("a defineGuard that replies and returns nothing never reaches the handler", async () => {
    const guard = defineGuard({
      name: "refuse",
      resolve: async (_req, reply) => {
        reply.code(403).send({ code: "arc.forbidden", message: "no", status: 403 });
      },
    });
    const resource = defineResource({
      name: "gate",
      adapter,
      permissions: { list: allowPublic(), create: allowPublic() },
      routeGuards: [guard.preHandler],
    });
    app = await createApp({
      logger: false,
      preset: "testing",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      plugins: async (f) => {
        for (let i = 0; i < 3; i++) {
          f.addHook("preSerialization", async (_req, _reply, payload) => {
            await tick();
            return payload;
          });
        }
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/gates", payload: {} });
    expect(res.statusCode).toBe(403);
    await tick();
    expect(work.create).not.toHaveBeenCalled();
  });
});
