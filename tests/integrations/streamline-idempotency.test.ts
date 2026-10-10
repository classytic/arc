/**
 * `streamlinePlugin({ idempotency: { required } })` fences the mutating workflow routes:
 * keyless → 400 `arc.idempotency_key_required`, a keyed retry replays, the permission gate
 * answers first, the header key becomes the run's `idempotencyKey`, a different body key
 * is refused, and boot refuses a fence nothing enforces.
 */

import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import {
  streamlinePlugin,
  type WorkflowLike,
  type WorkflowRunLike,
} from "../../src/integrations/streamline.js";

function run(id: string, workflowId: string): WorkflowRunLike {
  return { _id: id, workflowId, status: "running", createdAt: new Date(), updatedAt: new Date() };
}

function workflow(id: string) {
  let n = 0;
  const start = vi.fn(async (_input: unknown, _opts?: { idempotencyKey?: string }) =>
    run(`run-${++n}`, id),
  );
  const execute = vi.fn(async (runId: string) => run(runId, id));
  const wf: WorkflowLike = {
    definition: { id, name: id, steps: {} },
    engine: {
      start,
      execute,
      resume: vi.fn(async (runId: string) => run(runId, id)),
      cancel: vi.fn(async (runId: string) => run(runId, id)),
      get: vi.fn(async (runId: string) => run(runId, id)),
    },
    start,
    resume: vi.fn(async (runId: string) => run(runId, id)),
    cancel: vi.fn(async (runId: string) => run(runId, id)),
    get: vi.fn(async (runId: string) => run(runId, id)),
  };
  return { wf, start, execute };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(opts: { allowStart?: boolean; workflowsFilter?: string[] } = {}) {
  const billing = workflow("billing");
  const other = workflow("other");
  const routes: RouteOptions[] = [];
  app = Fastify({ logger: false });
  app.addHook("onRoute", (r) => {
    routes.push(r);
  });
  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
  await app.register(streamlinePlugin, {
    workflows: [billing.wf, other.wf],
    auth: false,
    permissions: { start: () => opts.allowStart ?? true },
    idempotency: {
      required: ["start", "execute"],
      ...(opts.workflowsFilter ? { workflows: opts.workflowsFilter } : {}),
    },
  });
  await app.ready();
  return { app, billing, other, routes };
}

describe("streamline idempotency fence", () => {
  it("start: keyless refused; header key replays and is the run's idempotencyKey", async () => {
    const { app, billing } = await boot();
    const keyless = await app.inject({
      method: "POST",
      url: "/workflows/billing/start",
      payload: {},
    });
    expect(keyless.statusCode).toBe(400);
    expect(keyless.json().code).toBe("arc.idempotency_key_required");
    expect(billing.start).not.toHaveBeenCalled();

    const call = () =>
      app.inject({
        method: "POST",
        url: "/workflows/billing/start",
        headers: { "idempotency-key": "k1" },
        payload: { input: { a: 1 } },
      });
    expect((await call()).statusCode).toBe(201);
    expect((await call()).headers["x-idempotency-replayed"]).toBe("true");
    expect(billing.start).toHaveBeenCalledTimes(1);
    expect(billing.start.mock.calls[0]?.[1]?.idempotencyKey).toBe("k1");
  });

  it("start: a body idempotencyKey different from the header is refused", async () => {
    const { app, billing } = await boot();
    const res = await app.inject({
      method: "POST",
      url: "/workflows/billing/start",
      headers: { "idempotency-key": "k1" },
      payload: { input: {}, idempotencyKey: "k2" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("arc.idempotency_key_reused");
    expect(billing.start).not.toHaveBeenCalled();
  });

  it("execute is fenced; cancel and resume (not declared) stay optional", async () => {
    const { app, billing } = await boot();
    const keyless = await app.inject({ method: "POST", url: "/workflows/billing/runs/r1/execute" });
    expect(keyless.json().code).toBe("arc.idempotency_key_required");
    expect(billing.execute).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: "POST", url: "/workflows/billing/runs/r1/cancel" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/workflows/billing/runs/r1/resume" })).statusCode,
    ).toBe(200);
  });

  it("the permission gate answers before the key check", async () => {
    const { app } = await boot({ allowStart: false });
    const res = await app.inject({ method: "POST", url: "/workflows/billing/start", payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("route config publishes the fence; `workflows` narrows it", async () => {
    const { routes } = await boot({ workflowsFilter: ["billing"] });
    const fenced = (url: string) =>
      routes.find((r) => r.url === url)?.config?.idempotency?.required === true;
    expect(fenced("/workflows/billing/start")).toBe(true);
    expect(fenced("/workflows/billing/runs/:runId/execute")).toBe(true);
    expect(fenced("/workflows/billing/runs/:runId/cancel")).toBe(false);
    expect(fenced("/workflows/other/start")).toBe(false);
  });

  it("boot refuses the fence without idempotencyPlugin, or for an unknown workflow", async () => {
    const bare = Fastify({ logger: false });
    await expect(
      bare.register(streamlinePlugin, {
        workflows: [workflow("billing").wf],
        auth: false,
        idempotency: { required: ["start"] },
      }),
    ).rejects.toThrow(/idempotencyPlugin is not registered/);
    await bare.close();

    const host = Fastify({ logger: false });
    await host.register(idempotencyPlugin, { enabled: true });
    await expect(
      host.register(streamlinePlugin, {
        workflows: [workflow("billing").wf],
        auth: false,
        idempotency: { required: ["start"], workflows: ["nope"] },
      }),
    ).rejects.toThrow(/unknown workflow 'nope'/);
    await host.close();
  });
});
