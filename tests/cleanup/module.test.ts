/**
 * `createDataCleanupModule` — module composition + route wiring.
 *
 * The service behavior is covered in service.test.ts; here we verify the Arc
 * module shape (name, service export, boot-time recipe uniqueness) and that
 * each raw route adapts request → service → reply correctly, including
 * permission attachment and the 202 execute status.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  CleanupError,
  type CleanupEvidenceStore,
  type CleanupManifest,
  type CleanupRecipe,
  type CleanupRun,
  type CleanupRunStore,
  createDataCleanupModule,
  type PurgeEvidence,
} from "../../src/cleanup/index.js";
import type { RouteDefinition } from "../../src/types/resource/routes.js";

function memRunStore(): CleanupRunStore & { runs: Map<string, CleanupRun> } {
  const runs = new Map<string, CleanupRun>();
  return {
    runs,
    async create(run) {
      runs.set(run.id, run);
    },
    async get(id) {
      return runs.get(id) ?? null;
    },
    async update(id, patch) {
      const cur = runs.get(id);
      if (cur) runs.set(id, { ...cur, ...patch });
    },
    async findActiveDestructive() {
      for (const r of runs.values()) if (r.status === "running" || r.status === "planned") return r;
      return null;
    },
  };
}

function memEvidenceStore(): CleanupEvidenceStore {
  const evidence: PurgeEvidence[] = [];
  const manifests: CleanupManifest[] = [];
  return {
    async recordEvidence(e) {
      evidence.push(e);
    },
    async recordManifest(m) {
      manifests.push(m);
    },
  };
}

function recipe(id = "cleanup.drafts"): CleanupRecipe {
  return {
    id,
    label: "Remove drafts",
    destructive: true,
    available: async () => ({ available: true }),
    plan: async () => ({ items: [{ resource: "orders", estimated: 3 }], confirmationPhrase: "GO" }),
    execute: async () => ({ status: "completed", results: [{ resource: "orders", processed: 3, ok: true }] }),
    verify: async () => ({ ok: true, checks: [] }),
  };
}

const allow = () => true;

function makeModule(over: Partial<Parameters<typeof createDataCleanupModule>[0]> = {}) {
  let seq = 0;
  return createDataCleanupModule({
    recipes: [recipe()],
    runStore: memRunStore(),
    evidenceStore: memEvidenceStore(),
    permissions: { view: allow, execute: allow },
    generateId: () => `id-${seq++}`,
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    ...over,
  });
}

/** Build a fake reply capturing status + payload. */
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

function routeOf(module: ReturnType<typeof createDataCleanupModule>): (method: string, path: string) => RouteDefinition {
  const resources = (module.resources as () => readonly { routes: readonly RouteDefinition[] }[])();
  const routes = resources[0].routes;
  return (method, path) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`route ${method} ${path} not found`);
    return r;
  };
}

async function invoke(route: RouteDefinition, req: Partial<FastifyRequest>, reply = fakeReply()) {
  const handler = route.handler as (req: unknown, reply: unknown) => Promise<unknown>;
  await handler(req, reply);
  return reply;
}

describe("createDataCleanupModule — composition", () => {
  it("returns an ArcModule exposing the live service via bootstrap", async () => {
    const module = makeModule();
    expect(module.name).toBe("data-cleanup");
    const service = await module.bootstrap!({} as never);
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor: { ref: "user:a", kind: "user" } });
    expect(plan.estimatedTotal).toBe(3);
  });

  it("fails fast at construction on a duplicate recipe id", () => {
    expect(() => makeModule({ recipes: [recipe("dup"), recipe("dup")] })).toThrow(CleanupError);
  });

  it("mounts the operations resource at the default prefix with all five routes", () => {
    const module = makeModule();
    const resources = (module.resources as () => readonly { prefix: string; routes: readonly RouteDefinition[] }[])();
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

  it("honors a custom prefix + module name", () => {
    const module = makeModule({ prefix: "/admin/cleanup", moduleName: "cleanup-center" });
    expect(module.name).toBe("cleanup-center");
    const resources = (module.resources as () => readonly { prefix: string }[])();
    expect(resources[0].prefix).toBe("/admin/cleanup");
  });
});

describe("createDataCleanupModule — routes", () => {
  it("GET /recipes returns recipe cards", async () => {
    const route = routeOf(makeModule())("GET", "/recipes");
    const reply = await invoke(route, {});
    expect(reply.payload).toEqual({ recipes: [{ id: "cleanup.drafts", label: "Remove drafts", destructive: true }] });
  });

  it("POST /preview returns a sealed plan", async () => {
    const route = routeOf(makeModule())("POST", "/preview");
    const reply = await invoke(route, { body: { recipe: "cleanup.drafts" }, scope: undefined });
    const plan = reply.payload as { digest: string; confirmationPhrase: string };
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.confirmationPhrase).toBe("GO");
  });

  it("POST /runs executes a confirmed plan and replies 202", async () => {
    const module = makeModule();
    const preview = routeOf(module)("POST", "/preview");
    const previewReply = await invoke(preview, { body: { recipe: "cleanup.drafts" } });
    const plan = previewReply.payload as { digest: string };

    const runsRoute = routeOf(module)("POST", "/runs");
    const reply = await invoke(runsRoute, {
      body: { recipe: "cleanup.drafts", planDigest: plan.digest, reason: "cleaning", confirmation: "GO" },
    });
    expect(reply.statusCode).toBe(202);
    expect((reply.payload as CleanupRun).recipeId).toBe("cleanup.drafts");
  });

  it("POST /runs/:id/action rejects an unknown action", async () => {
    const route = routeOf(makeModule())("POST", "/runs/:id/action");
    await expect(invoke(route, { params: { id: "x" }, body: { action: "explode" } })).rejects.toMatchObject({
      code: "CLEANUP_INVALID_ACTION",
    });
  });

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
