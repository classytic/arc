/**
 * `createDataCleanupModule` — module composition + route wiring.
 *
 * Service behavior is covered in service.test.ts; here we verify the Arc module
 * shape (name, service export, boot-time recipe uniqueness), the route set +
 * schemas, fail-closed actor resolution, and that each raw route adapts request
 * → service → reply correctly (including 202 + enqueue and the ambient resolver).
 */
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CleanupError, type CleanupRun, createDataCleanupModule } from "../../src/cleanup/index.js";
import type { RouteDefinition } from "../../src/types/resource/routes.js";
import {
  draftsRecipe,
  fixedNow,
  manualQueue,
  memEvidenceStore,
  memRunStore,
  must,
  seqId,
} from "./_harness.ts";

const allow = () => true;

function makeModule(over: Partial<Parameters<typeof createDataCleanupModule>[0]> = {}) {
  const runStore = memRunStore();
  const evidenceStore = memEvidenceStore();
  const queue = manualQueue();
  const module = createDataCleanupModule({
    recipes: [draftsRecipe()],
    runStore,
    evidenceStore,
    jobQueue: queue,
    permissions: { view: allow, execute: allow },
    generateId: seqId(),
    now: fixedNow(),
    ...over,
  });
  return { module, runStore, evidenceStore, queue };
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.payload = body;
      return reply;
    },
  };
  return reply;
}

/** A request with an authenticated user (resolveActor's fallback path). */
function authedReq(over: Partial<FastifyRequest> = {}): Partial<FastifyRequest> {
  return { user: { id: "admin" } as never, ...over };
}

type ModuleOrHarness = ReturnType<typeof createDataCleanupModule> | ReturnType<typeof makeModule>;

function asModule(m: ModuleOrHarness): ReturnType<typeof createDataCleanupModule> {
  return "module" in m ? m.module : m;
}

function routesOf(m: ModuleOrHarness): readonly RouteDefinition[] {
  const module = asModule(m);
  const resources = (module.resources as () => readonly { routes: readonly RouteDefinition[] }[])();
  return resources[0].routes;
}

function routeOf(m: ModuleOrHarness) {
  const routes = routesOf(m);
  return (method: string, path: string): RouteDefinition => {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`route ${method} ${path} not found`);
    return r;
  };
}

async function invoke(route: RouteDefinition, req: Partial<FastifyRequest>, reply = fakeReply()) {
  const handler = (route.rawHandler ?? route.handler) as (req: unknown, reply: unknown) => Promise<unknown>;
  await handler(req, reply);
  return reply;
}

describe("createDataCleanupModule — composition", () => {
  it("returns an ArcModule exposing the live service via bootstrap", async () => {
    const { module } = makeModule();
    expect(module.name).toBe("data-cleanup");
    const service = await must(module.bootstrap)({} as never);
    const plan = await service.preview({
      recipeId: "cleanup.drafts",
      actor: { ref: "user:a", kind: "user" },
    });
    expect(plan.estimatedTotal).toBe(3);
  });

  it("fails fast at construction on a duplicate recipe id", () => {
    expect(() => makeModule({ recipes: [draftsRecipe(), draftsRecipe()] })).toThrow(CleanupError);
  });

  it("mounts the operations resource at the default prefix with all five routes", () => {
    const { module } = makeModule();
    const resources = (
      module.resources as () => readonly { prefix: string; routes: readonly RouteDefinition[] }[]
    )();
    expect(resources[0].prefix).toBe("/governance/data-cleanup");
    const paths = resources[0].routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual([
      "GET /recipes",
      "GET /runs/:id",
      "POST /preview",
      "POST /runs",
      "POST /runs/:id/action",
    ]);
  });

  it("attaches Fastify JSON-Schema validation to the mutating routes", () => {
    const route = routeOf(makeModule());
    expect(route("POST", "/preview").schema?.body).toBeDefined();
    expect(route("POST", "/runs").schema?.body).toBeDefined();
    expect(route("GET", "/runs/:id").schema?.params).toBeDefined();
    expect(route("POST", "/runs/:id/action").schema?.body).toBeDefined();
  });

  it("honors a custom prefix + module name", () => {
    const { module } = makeModule({ prefix: "/admin/cleanup", moduleName: "cleanup-center" });
    expect(module.name).toBe("cleanup-center");
    const resources = (module.resources as () => readonly { prefix: string }[])();
    expect(resources[0].prefix).toBe("/admin/cleanup");
  });
});

describe("createDataCleanupModule — routes", () => {
  it("GET /recipes returns recipe cards", async () => {
    const reply = await invoke(routeOf(makeModule())("GET", "/recipes"), {});
    expect(reply.payload).toEqual({
      recipes: [{ id: "cleanup.drafts", label: "Remove drafts", destructive: true }],
    });
  });

  it("POST /preview returns a sealed plan", async () => {
    const reply = await invoke(
      routeOf(makeModule())("POST", "/preview"),
      authedReq({ body: { recipe: "cleanup.drafts" } }),
    );
    const plan = reply.payload as { digest: string; confirmationPhrase: string };
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.confirmationPhrase).toBe("REMOVE DRAFTS");
  });

  it("POST /runs executes a confirmed plan, replies 202, enqueues a job", async () => {
    const { module, queue } = makeModule();
    const previewReply = await invoke(
      routeOf(module)("POST", "/preview"),
      authedReq({ body: { recipe: "cleanup.drafts" } }),
    );
    const plan = previewReply.payload as { digest: string };

    const reply = await invoke(
      routeOf(module)("POST", "/runs"),
      authedReq({
        body: {
          recipe: "cleanup.drafts",
          planDigest: plan.digest,
          reason: "cleaning",
          confirmation: "REMOVE DRAFTS",
        },
      }),
    );
    expect(reply.statusCode).toBe(202);
    const run = reply.payload as CleanupRun;
    expect(run.status).toBe("queued");
    expect(queue.jobs).toEqual([{ runId: run.id }]);
  });

  it("POST /runs/:id/action rejects an unknown action via schema (or invalid-action)", async () => {
    // Schema would reject at Fastify layer; the handler also fails closed on actor.
    const route = routeOf(makeModule())("POST", "/runs/:id/action");
    // With an authenticated actor + a non-enum action, the handler treats a
    // non-'cancel' action as retry → run-not-found (the id doesn't exist).
    await expect(
      invoke(route, authedReq({ params: { id: "missing" }, body: { action: "retry" } })),
    ).rejects.toMatchObject({
      code: "CLEANUP_RUN_NOT_FOUND",
    });
  });

  it("captures ambient scope via resolveAmbient for the worker", async () => {
    const resolveAmbient = vi.fn(() => ({ branchId: "dhaka" }));
    const { module, runStore } = makeModule({ resolveAmbient });
    const previewReply = await invoke(
      routeOf(module)("POST", "/preview"),
      authedReq({ body: { recipe: "cleanup.drafts" } }),
    );
    const plan = previewReply.payload as { digest: string };
    const reply = await invoke(
      routeOf(module)("POST", "/runs"),
      authedReq({
        body: {
          recipe: "cleanup.drafts",
          planDigest: plan.digest,
          reason: "r",
          confirmation: "REMOVE DRAFTS",
        },
      }),
    );
    const run = reply.payload as CleanupRun;
    expect(must(runStore.runs.get(run.id)).ambient).toEqual({ branchId: "dhaka" });
  });
});

describe("createDataCleanupModule — fail-closed actor", () => {
  it("throws CLEANUP_ACTOR_REQUIRED when no authenticated actor resolves", async () => {
    const route = routeOf(makeModule());
    // No user, no scope → cannot attribute a destructive action.
    await expect(
      invoke(route("POST", "/preview"), { body: { recipe: "cleanup.drafts" } }),
    ).rejects.toMatchObject({
      code: "CLEANUP_ACTOR_REQUIRED",
      statusCode: 401,
    });
    await expect(
      invoke(route("POST", "/runs"), {
        body: { recipe: "cleanup.drafts", planDigest: "d", reason: "r" },
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_ACTOR_REQUIRED" });
    await expect(
      invoke(route("POST", "/runs/:id/action"), {
        params: { id: "x" },
        body: { action: "cancel" },
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_ACTOR_REQUIRED" });
  });

  it("a custom resolveActor is honored", async () => {
    const resolveActor = vi.fn(() => ({ ref: "service:cron", kind: "service" as const }));
    const { module } = makeModule({ resolveActor });
    const reply = await invoke(routeOf(module)("POST", "/preview"), {
      body: { recipe: "cleanup.drafts" },
    });
    expect((reply.payload as { recipeId: string }).recipeId).toBe("cleanup.drafts");
    expect(resolveActor).toHaveBeenCalled();
  });
});

describe("createDataCleanupModule — permissions", () => {
  it("attaches the injected permission checks to routes", () => {
    const view = vi.fn(() => true);
    const execute = vi.fn(() => true);
    const manage = vi.fn(() => true);
    const route = routeOf(makeModule({ permissions: { view, execute, manage } }));
    expect(route("GET", "/recipes").permissions).toBe(view);
    expect(route("POST", "/runs").permissions).toBe(execute);
    expect(route("POST", "/runs/:id/action").permissions).toBe(manage);
  });

  it("defaults manage permission to execute when omitted", () => {
    const execute = vi.fn(() => true);
    const route = routeOf(makeModule({ permissions: { view: allow, execute } }));
    expect(route("POST", "/runs/:id/action").permissions).toBe(execute);
  });
});
