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

/**
 * Where the declaration is made must not change whether it is heard.
 *
 * A Fastify child (`register` with an un-`fp`-wrapped plugin) is
 * `Object.create(parent)`: a symbol READ finds the parent's array through the
 * prototype chain, but a symbol WRITE always lands on the child. With the
 * registry created lazily, the FIRST declarant therefore decided where it
 * lived — and a host declaring from inside its own encapsulated `register()`
 * before anything else declared got an own array on the child that the root
 * audit never read. The boot passed. Silence from the mechanism whose entire
 * job is to refuse to boot is the worst failure it has, so it is pinned here.
 *
 * Every case below declares from a child and NOTHING declares at the root, so
 * the root array only exists if `createApp` seeded it up front.
 */
describe("runtime capability registry — encapsulation", () => {
  const distributed = {
    runtime: "distributed",
    rateLimit: false,
    stores: { events: sharedTransport },
  } as const;

  it("a declaration from an ENCAPSULATED child reaches the audit", async () => {
    await arcAppRefuses(
      {
        ...distributed,
        plugins: async (f) => {
          // Un-`fp`-wrapped: a real encapsulation boundary, the shape a host
          // writes to keep its own decorators out of the root.
          await f.register(async (child) => {
            declareRuntimeCapability(child, {
              subsystem: "billing.child-scoped-cache",
              durability: "memory",
              detail: "declared inside an encapsulated plugin",
            });
          });
        },
      },
      /billing\.child-scoped-cache/,
    );
  });

  it("nesting depth does not lose it", async () => {
    await arcAppRefuses(
      {
        ...distributed,
        plugins: async (f) => {
          await f.register(async (child) => {
            await child.register(async (grandchild) => {
              declareRuntimeCapability(grandchild, {
                subsystem: "billing.grandchild-cache",
                durability: "memory",
              });
            });
          });
        },
      },
      /billing\.grandchild-cache/,
    );
  });

  it("a child declaring FIRST does not orphan a later root declaration", async () => {
    // Order is the actual trigger: pre-fix, the child's own array won the slot
    // and a root declaration made afterwards landed somewhere else entirely.
    // BOTH must appear in the one error.
    const err = await arcApp({
      ...distributed,
      plugins: async (f) => {
        await f.register(async (child) => {
          declareRuntimeCapability(child, {
            subsystem: "first.from-child",
            durability: "memory",
          });
        });
        declareRuntimeCapability(f, {
          subsystem: "second.from-root",
          durability: "memory",
        });
      },
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("first.from-child");
    expect(err?.message).toContain("second.from-root");
    // One error naming every violator — not one boot per fix.
    expect(err?.message).toContain("2 subsystem(s)");
  });

  it("`accepted` from a child is honoured too — the boot passes", async () => {
    const app = await arcApp({
      ...distributed,
      plugins: async (f) => {
        await f.register(async (child) => {
          declareRuntimeCapability(child, {
            subsystem: "http.child-micro-cache",
            durability: "memory",
            accepted: true,
            detail: "per-replica by design",
          });
        });
      },
    });
    expect(app).toBeTruthy();
  });

  it("`accepted` from a child is CLASSIFIED, not merely lost", async () => {
    // The test above passes vacuously if a child's declaration is dropped —
    // no declaration is also no violation. This one can't: a second child
    // declares a real violation, so the boot fails either way and the message
    // shows whether the accepted sibling was heard and correctly exonerated,
    // rather than never having arrived.
    const err = await arcApp({
      ...distributed,
      plugins: async (f) => {
        await f.register(async (child) => {
          declareRuntimeCapability(child, {
            subsystem: "http.accepted-child",
            durability: "memory",
            accepted: true,
          });
        });
        await f.register(async (child) => {
          declareRuntimeCapability(child, {
            subsystem: "billing.violating-child",
            durability: "memory",
          });
        });
      },
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("billing.violating-child");
    expect(err?.message).not.toContain("http.accepted-child");
    expect(err?.message).toContain("1 subsystem(s)");
  });
});
