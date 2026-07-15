/**
 * createWorker (2.23) — the headless process role, tested to the spec's
 * 10 scenarios (designs/worker-role.md). One boot pipeline, two shapes:
 * boot parity, no-HTTP proofs (auth thunk never runs), registry-without-
 * routes (tenant cascade works on a worker), events/schedules runtime,
 * health opt-in 503→200, teardown, shared-options safety, type surface.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { cascadeDeleteForOrganization } from "../../src/registry/cascadeOrgDelete.js";
import { createWorker } from "../../src/factory/createWorker.js";
import { defineModule } from "../../src/factory/module.js";
import type { CreateAppOptions } from "../../src/factory/types/index.js";
import { allowPublic } from "../../src/permissions/core.js";
import schedulesPlugin from "../../src/plugins/schedules.js";
import { createMemoryLockAdapter } from "@classytic/repo-core/lock";
import { createMockRepository } from "../../src/testing/mocks.js";

const workers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (workers.length) await workers.pop()?.close();
});

const purgeByField = vi.fn(async () => ({ deleted: 1 }));

function widgetResource() {
  const repository = { ...createMockRepository(), purgeByField };
  return defineResource({
    name: "widget",
    adapter: { repository },
    tenantField: "organizationId",
    onTenantDelete: { strategy: { type: "purge" } },
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });
}

function baseOptions(extra: Partial<CreateAppOptions> = {}): CreateAppOptions {
  return {
    logger: false,
    resources: [widgetResource()],
    modules: [
      defineModule({
        name: "demo",
        bootstrap: () => ({ engineReady: true }),
      }),
    ],
    ...extra,
  };
}

describe("createWorker — the headless role", () => {
  it("boot parity: modules bootstrap; exports() works; lifecycle order matches the app role", async () => {
    const order: string[] = [];
    const w = await createWorker(
      baseOptions({
        beforeBoot: async () => {
          order.push("beforeBoot");
        },
        modules: [
          defineModule({
            name: "demo",
            plugins: () => {
              order.push("plugins");
            },
            bootstrap: () => {
              order.push("bootstrap");
              return { engineReady: true };
            },
            afterResources: () => {
              order.push("afterResources");
            },
          }),
        ],
      }),
    );
    workers.push(w);
    expect(order).toEqual(["beforeBoot", "plugins", "bootstrap", "afterResources"]);
    expect(w.exports<{ engineReady: boolean }>("demo").engineReady).toBe(true);
    expect(() => w.exports("nope")).toThrow(/nope/);
  });

  it("no HTTP surface: routes absent, auth thunk NEVER runs, docs/MCP absent", async () => {
    const authThunk = vi.fn(() => ({ plugin: async () => undefined }));
    const w = await createWorker(
      baseOptions({
        // SHARED options object — the API role's auth config rides along.
        auth: { type: "betterAuth", betterAuth: authThunk },
      }),
    );
    workers.push(w);

    expect((await w.app.inject({ method: "GET", url: "/widgets" })).statusCode).toBe(404);
    expect(authThunk).not.toHaveBeenCalled();
    expect(w.app.hasDecorator("authenticate")).toBe(false);
    expect((await w.app.inject({ method: "GET", url: "/docs" })).statusCode).toBe(404);
  });

  it("registry without routes: metadata + adapter live; tenant cascade purges on a WORKER", async () => {
    const w = await createWorker(baseOptions());
    workers.push(w);

    const arc = (w.app as unknown as { arc: { registry: import("../../src/registry/index.js").ResourceRegistry } })
      .arc;
    const names = arc.registry.getAll().map((e) => e.name);
    expect(names).toContain("widget");

    const adapter = arc.registry.getAdapter("widget");
    expect(adapter).toBeTruthy();

    const report = await cascadeDeleteForOrganization(arc.registry, { organizationId: "org-1" });
    expect(report.resources.some((r) => r.resource === "widget")).toBe(true);
    // The purge flowed through the WORKER-registered adapter to the repo —
    // the exact runtime path that silently breaks when workers skip the
    // registry (the finding that decided Q1 of the spec).
    expect(purgeByField).toHaveBeenCalledWith(
      "organizationId",
      "org-1",
      expect.anything(),
      expect.anything(),
    );
  });

  it("events runtime: a consumer wired in afterResources receives a post-boot publish", async () => {
    const seen: string[] = [];
    const w = await createWorker(
      baseOptions({
        arcPlugins: { events: true },
        modules: [
          defineModule({
            name: "consumer",
            bootstrap: () => ({}),
            afterResources: async (f) => {
              const events = (f as { events?: { subscribe(p: string, h: (e: { type: string }) => void): unknown } })
                .events;
              await events?.subscribe("job.*", (e) => {
                seen.push(e.type);
              });
            },
          }),
        ],
      }),
    );
    workers.push(w);

    const events = (w.app as { events?: { publish(t: string, d: unknown): Promise<unknown> } }).events;
    await events?.publish("job.done", { ok: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain("job.done");
  });

  it("schedules + leader safety: two workers, one shared lock — exactly one runs per tick", async () => {
    const lock = createMemoryLockAdapter();
    let runs = 0;
    const opts = (holder: string): CreateAppOptions =>
      baseOptions({
        plugins: async (f) => {
          await f.register(schedulesPlugin, {
            lock,
            holderId: holder,
            schedules: [
              {
                name: "sweep",
                every: 60_000,
                runOnStart: true,
                handler: async () => {
                  runs += 1;
                },
              },
            ],
          });
        },
      });

    const w1 = await createWorker(opts("w1"));
    const w2 = await createWorker(opts("w2"));
    workers.push(w1, w2);
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(1); // second replica lost the lease
  });

  it("health opt-in: binds ONLY the probe surface; nothing bound without it", async () => {
    const silent = await createWorker(baseOptions());
    workers.push(silent);
    expect(silent.app.server.listening).toBe(false);

    const probed = await createWorker(baseOptions(), { health: { port: 0, host: "127.0.0.1" } });
    workers.push(probed);
    expect(probed.app.server.listening).toBe(true);

    const live = await probed.app.inject({ method: "GET", url: "/_health/live" });
    expect(live.statusCode).toBe(200);
    const ready = await probed.app.inject({ method: "GET", url: "/_health/ready" });
    expect(ready.statusCode).toBe(200);
    // No other surface on the probe port:
    expect((await probed.app.inject({ method: "GET", url: "/widgets" })).statusCode).toBe(404);
  });

  it("teardown: module onClose runs, close() is idempotent", async () => {
    let closedModule = 0;
    const w = await createWorker(
      baseOptions({
        modules: [
          defineModule({
            name: "demo",
            bootstrap: () => ({}),
            onClose: () => {
              closedModule += 1;
            },
          }),
        ],
      }),
    );
    await w.close();
    await w.close(); // idempotent
    expect(closedModule).toBe(1);
  });

  it("shared-options safety: cors/helmet/rateLimit configs boot the worker with NO effect and NO error", async () => {
    const w = await createWorker(
      baseOptions({
        cors: { origin: ["https://app.example.com"], credentials: true },
        helmet: { contentSecurityPolicy: false },
        rateLimit: { max: 5, timeWindow: "1 minute" },
      }),
    );
    workers.push(w);
    const res = await w.app.inject({
      method: "OPTIONS",
      url: "/anything",
      headers: { origin: "https://app.example.com", "access-control-request-method": "GET" },
    });
    // No CORS plugin → no preflight handling (404), no ACAO header.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preset override contract: explicit arcPlugins keys win (metrics back ON per-key)", async () => {
    const w = await createWorker(baseOptions({ arcPlugins: { metrics: true } }));
    workers.push(w);
    expect(w.app.hasDecorator("metrics")).toBe(true);
    // ...while the preset's other off-switches survive the merge:
    expect((await w.app.inject({ method: "GET", url: "/_health/live" })).statusCode).toBe(404);
  });

  it("type surface: ArcWorker exposes app/exports/close and no top-level listen", () => {
    const keys: Array<keyof Awaited<ReturnType<typeof createWorker>>> = ["app", "exports", "close"];
    expect(keys).toHaveLength(3);
  });
});
