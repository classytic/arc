/**
 * Runtime capability registry — the checklist becomes enforcement.
 *
 * The gap: `validateDistributedRuntime` sees only what `createApp` receives.
 * State a HOST wires inside `plugins()` was invisible — it lived on a wiki
 * checklist, and a checklist is not enforcement. Pinned:
 *
 *   1. A host-declared memory capability FAILS a distributed boot, by name.
 *   2. `accepted: true` (per-process by design) passes with an info line.
 *   3. Non-distributed runtimes enforce nothing.
 *   4. Arc's own webhooks plugin declares its default in-memory store.
 *   5. So does every other memory-backed default arc ships (sessions, usage,
 *      audit, dynamic-permission cache, query cache, websocket adapter +
 *      pushRef store) — and a host-supplied shared store removes the entry.
 *   6. The response cache is per-replica BY DESIGN and boots accepted.
 */

import { describe, expect, it } from "vitest";
import { declareRuntimeCapability } from "../../src/utils/index.js";
import { arcApp, arcAppRefuses } from "../_harness/index.js";

// A minimal shared events transport so runtime: 'distributed' passes the
// constructor-time guard — this suite is about what that guard CANNOT see.
const sharedTransport = {
  name: "test-shared",
  publish: async () => {},
  subscribe: async () => {},
  close: async () => {},
} as never;

describe("runtime capability registry", () => {
  it("a host-wired memory capability FAILS a distributed boot — named, not silent", async () => {
    await arcAppRefuses(
      {
        runtime: "distributed",
        rateLimit: false,
        stores: { events: sharedTransport },
        plugins: async (f) => {
          // The checklist case: host wires a replica-local store in plugins().
          declareRuntimeCapability(f, {
            subsystem: "billing.sequence-cache",
            durability: "memory",
            detail: "invoice numbering cached per process",
          });
        },
      },
      /billing\.sequence-cache/,
    );
  });

  it("accepted per-process state passes distributed — the topology decision is explicit", async () => {
    const app = await arcApp({
      runtime: "distributed",
      rateLimit: false,
      stores: { events: sharedTransport },
      plugins: async (f) => {
        declareRuntimeCapability(f, {
          subsystem: "http.micro-cache",
          durability: "memory",
          accepted: true,
          detail: "short-TTL hot-path cache; correctness from TTL, not shared state",
        });
      },
    });
    expect(app).toBeTruthy();
  });

  it("non-distributed runtimes enforce nothing — declarations are informational", async () => {
    const app = await arcApp({
      plugins: async (f) => {
        declareRuntimeCapability(f, {
          subsystem: "anything.memory",
          durability: "memory",
        });
      },
    });
    expect(app).toBeTruthy();
  });

  /** Boot with the given `plugins()` and return the audit error (or undefined). */
  async function distributedBootError(
    plugins: (f: import("fastify").FastifyInstance) => Promise<void>,
  ): Promise<Error | undefined> {
    return arcApp({
      runtime: "distributed",
      rateLimit: false,
      stores: { events: sharedTransport },
      plugins,
    }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
  }

  const MEMORY_DEFAULTS = [
    "auth.sessions",
    "usage.store",
    "audit.store",
    "permissions.dynamic-cache",
    "cache.query",
  ];

  it("arc's memory-backed DEFAULTS are all reported under distributed — one error, every subsystem named", async () => {
    const { default: usagePlugin } = await import("../../src/usage/usagePlugin.js");
    const { default: auditPlugin } = await import("../../src/audit/auditPlugin.js");
    const { queryCachePlugin } = await import("../../src/cache/queryCachePlugin.js");
    const { createSessionManager, MemorySessionStore } = await import(
      "../../src/auth/sessionManager.js"
    );
    const { createDynamicPermissionMatrix } = await import("../../src/permissions/dynamic.js");

    const err = await distributedBootError(async (f) => {
      await f.register(usagePlugin, {});
      await f.register(auditPlugin, { enabled: true });
      await f.register(queryCachePlugin, {});
      const sessions = createSessionManager({
        store: new MemorySessionStore(),
        secret: "s".repeat(32),
      });
      await f.register(sessions.plugin);
      createDynamicPermissionMatrix({
        resolveRolePermissions: async () => ({}),
        cache: { ttlSeconds: 60 },
        fastify: f,
      });
    });

    expect(err).toBeInstanceOf(Error);
    for (const subsystem of MEMORY_DEFAULTS) {
      expect(err?.message).toContain(subsystem);
    }
  });

  it("a host-supplied shared store REMOVES its entry — only what is still replica-local is named", async () => {
    const { default: usagePlugin } = await import("../../src/usage/usagePlugin.js");
    const { default: auditPlugin } = await import("../../src/audit/auditPlugin.js");
    const { queryCachePlugin } = await import("../../src/cache/queryCachePlugin.js");
    const { createSessionManager } = await import("../../src/auth/sessionManager.js");
    const { createDynamicPermissionMatrix } = await import("../../src/permissions/dynamic.js");

    // Stand-ins for Redis/DB-backed stores — the audit trusts the host's
    // choice of store; only arc's OWN memory defaults are the violation.
    const sharedCache = {
      name: "redis",
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      clear: async () => {},
    };
    const sharedSessions = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      deleteAll: async () => {},
      deleteAllExcept: async () => {},
    };

    const err = await distributedBootError(async (f) => {
      // Left on its default on purpose — the boot must still fail so the
      // message can be inspected for what is ABSENT.
      await f.register(usagePlugin, {});
      await f.register(auditPlugin, {
        enabled: true,
        customStores: [{ name: "db", log: async () => {} } as never],
      });
      await f.register(queryCachePlugin, { store: sharedCache });
      const sessions = createSessionManager({ store: sharedSessions, secret: "s".repeat(32) });
      await f.register(sessions.plugin);
      createDynamicPermissionMatrix({
        resolveRolePermissions: async () => ({}),
        cacheStore: sharedCache,
        fastify: f,
      });
    });

    expect(err?.message).toContain("usage.store");
    for (const subsystem of MEMORY_DEFAULTS.filter((s) => s !== "usage.store")) {
      expect(err?.message).not.toContain(subsystem);
    }
  });

  it("the response cache is per-replica BY DESIGN — declared accepted, distributed boot passes", async () => {
    const { responseCachePlugin } = await import("../../src/plugins/response-cache.js");
    const app = await arcApp({
      runtime: "distributed",
      rateLimit: false,
      stores: { events: sharedTransport },
      plugins: async (f) => {
        await f.register(responseCachePlugin, {});
      },
    });
    expect(app).toBeTruthy();
  });

  it("webhooks' DEFAULT in-memory store is a declared violation under distributed", async () => {
    const { default: webhookPlugin } = await import("../../src/integrations/webhooks.js");
    await arcAppRefuses(
      {
        runtime: "distributed",
        rateLimit: false,
        stores: { events: sharedTransport },
        plugins: async (f) => {
          await f.register(webhookPlugin, {});
        },
      },
      /webhooks\.store/,
    );
  });
});
