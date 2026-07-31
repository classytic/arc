import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheStore } from "../../src/cache/interface.js";
import {
  createDynamicPermissionMatrix,
  type PermissionContext,
} from "../../src/permissions/index.js";

/** Build a PermissionContext with scope on the request */
function makeCtx(
  overrides: {
    user?: Record<string, unknown> | null;
    orgId?: string;
    orgRoles?: string[];
    elevated?: boolean;
  } = {},
): PermissionContext {
  const req: Record<string, unknown> = {};

  if (overrides.elevated) {
    req.scope = { kind: "elevated", elevatedBy: "admin" };
  } else if (overrides.orgId || overrides.orgRoles) {
    req.scope = {
      kind: "member",
      organizationId: overrides.orgId ?? "",
      orgRoles: overrides.orgRoles ?? [],
    };
  } else if (overrides.user !== null && overrides.user !== undefined) {
    req.scope = { kind: "authenticated" };
  }

  return {
    user: overrides.user === undefined ? { id: "u1", role: [] } : overrides.user,
    request: req as any,
    resource: "product",
    action: "create",
  };
}

describe("createDynamicPermissionMatrix", () => {
  const roleMap = {
    owner: { product: ["create", "update", "delete"], order: ["approve"] },
    admin: { product: ["create", "update"] },
    viewer: { product: ["read"] },
  } as const;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("grants when org role has required permission", async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.can({ product: ["create"] });
    const result = await check(makeCtx({ orgId: "org1", orgRoles: ["admin"] }));
    expect(result).toBe(true);
  });

  it("denies when org role lacks required permission", async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.can({ product: ["delete"] });
    const result = await check(makeCtx({ orgId: "org1", orgRoles: ["admin"] }));
    expect(result).toEqual({
      effect: "deny",
      reason: "Missing permission: product:delete",
    });
  });

  it("resolves union across multiple org roles", async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.can({ order: ["approve"] });
    const result = await check(makeCtx({ orgId: "org1", orgRoles: ["viewer", "owner"] }));
    expect(result).toBe(true);
  });

  it("supports wildcard resource and action", async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => ({
        support: { "*": ["read"] },
        super_ops: { "*": ["*"] },
      }),
    });

    const readAny = perms.canAction("invoice", "read");
    const readResult = await readAny(makeCtx({ orgId: "org1", orgRoles: ["support"] }));
    expect(readResult).toBe(true);

    const writeAny = perms.canAction("invoice", "delete");
    const writeResult = await writeAny(makeCtx({ orgId: "org1", orgRoles: ["super_ops"] }));
    expect(writeResult).toBe(true);
  });

  it("grants elevated scope regardless of permissions", async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => ({}),
    });

    const check = perms.canAction("product", "delete");
    const result = await check(makeCtx({ elevated: true }));
    expect(result).toBe(true);
  });

  it("denies unauthenticated and missing org context", async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.canAction("product", "create");

    const unauth = await check(makeCtx({ user: null }));
    expect(unauth).toEqual({ effect: "deny", reason: "Authentication required" });

    const noOrg = await check(makeCtx({ user: { id: "u1", role: [] } }));
    expect(noOrg).toEqual({ effect: "deny", reason: "Organization membership required" });

    const noMembership = await check(makeCtx({ orgId: "org1", orgRoles: [] }));
    expect(noMembership).toEqual({ effect: "deny", reason: "Not a member of this organization" });
  });

  it("caches resolved matrix when cache ttl is enabled", async () => {
    const resolver = vi.fn(async () => roleMap);
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: resolver,
      cache: { ttlSeconds: 60 },
    });

    const check = perms.canAction("product", "create");
    const ctx = makeCtx({ orgId: "org1", orgRoles: ["admin"] });

    expect(await check(ctx)).toBe(true);
    expect(await check(ctx)).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);

    await perms.clearCache();
    expect(await check(ctx)).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("uses a custom cache key, but AUTO-NAMESPACES it per org (tenant isolation)", async () => {
    const resolver = vi.fn(async () => roleMap);
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: resolver,
      cache: {
        ttlSeconds: 60,
        // A bare per-user key with NO org — arc must still isolate by tenant.
        key: (ctx) => String((ctx.user as { id?: string } | null)?.id ?? "anon"),
      },
    });

    const check = perms.canAction("product", "create");
    // Same user, DIFFERENT orgs → arc namespaces the custom key by org, so each
    // org resolves its OWN matrix. Org B must NEVER read org A's cached matrix.
    await check(makeCtx({ orgId: "orgA", orgRoles: ["admin"], user: { id: "u1", role: [] } }));
    await check(makeCtx({ orgId: "orgB", orgRoles: ["admin"], user: { id: "u1", role: [] } }));
    expect(resolver).toHaveBeenCalledTimes(2);

    // Re-hitting org A is a cache hit (same namespaced key) — no third resolve.
    await check(makeCtx({ orgId: "orgA", orgRoles: ["admin"], user: { id: "u1", role: [] } }));
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("fails closed with a GENERIC reason when the resolver throws — no internal leak", async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => {
        throw new Error("DB unavailable at mongodb://secret-host:27017");
      },
    });

    const check = perms.canAction("product", "create");
    const result = await check(makeCtx({ orgId: "org1", orgRoles: ["admin"] }));
    expect(typeof result === "object" ? result.effect : result).toBe("deny");
    // The underlying exception text (host, driver internals) must NOT reach the client.
    const reason = typeof result === "object" ? (result.reason ?? "") : "";
    expect(reason).not.toContain("mongodb://");
    expect(reason).not.toContain("DB unavailable");
    expect(reason).toBe("Permission policy is temporarily unavailable");
  });

  it("uses external cache store adapter when provided", async () => {
    const get = vi.fn(
      async () => undefined as Record<string, Record<string, readonly string[]>> | undefined,
    );
    const set = vi.fn(async () => {});
    const cacheStore: CacheStore<Record<string, Record<string, readonly string[]>>> = {
      name: "mock-cache",
      get,
      set,
      delete: async () => {},
      clear: async () => {},
    };

    const resolver = vi.fn(async () => roleMap);
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: resolver,
      cacheStore,
      cache: { ttlSeconds: 60 },
    });

    const check = perms.canAction("product", "create");
    const result = await check(makeCtx({ orgId: "org1", orgRoles: ["admin"] }));

    expect(result).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("FALLBACK (no store.clear): invalidateByOrg evicts a custom-keyed matrix via the org index", async () => {
    const deleted: string[] = [];
    // A store WITHOUT `clear` — forces the per-key fallback path.
    const cacheStore: CacheStore<Record<string, Record<string, readonly string[]>>> = {
      name: "mock-cache",
      get: async () => undefined,
      set: async () => {},
      delete: async (key: string) => {
        deleted.push(key);
      },
    };

    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
      cacheStore,
      // A host key with NO `orgId::` prefix — a prefix scan alone would miss it.
      cache: { ttlSeconds: 60, key: (ctx) => `user:${ctx.user?.id}` },
    });

    await perms.canAction("product", "create")(makeCtx({ orgId: "org1", orgRoles: ["admin"] }));
    // The custom key is auto-namespaced by org (+ roles), found via the org index.
    await perms.invalidateByOrg("org1");
    expect(deleted.some((k) => k.includes("user:u1") && k.startsWith("org1::"))).toBe(true);
  });

  it("PREFERRED (store.clear): invalidateByOrg is restart-safe/cross-node via a prefix clear", async () => {
    // A SHARED store (stand-in for Redis) with prefix-aware `clear`.
    const store = new Map<string, unknown>();
    const clearedPatterns: string[] = [];
    const shared: CacheStore<Record<string, Record<string, readonly string[]>>> = {
      name: "shared",
      get: async (k) =>
        store.get(k) as Record<string, Record<string, readonly string[]>> | undefined,
      set: async (k, v) => {
        store.set(k, v);
      },
      delete: async (k) => {
        store.delete(k);
      },
      clear: async (pattern?: string) => {
        clearedPatterns.push(pattern ?? "*");
        if (!pattern) return void store.clear();
        const prefix = pattern.replace(/\*$/, "");
        for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
      },
    };

    // Node A populates the shared store for org1.
    const nodeA = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
      cacheStore: shared,
      cache: { ttlSeconds: 60, key: (ctx) => `user:${ctx.user?.id}` },
    });
    await nodeA.canAction("product", "create")(makeCtx({ orgId: "org1", orgRoles: ["admin"] }));
    expect([...store.keys()].some((k) => k.startsWith("org1::"))).toBe(true);

    // A FRESH process (empty in-process index) sharing the same store revokes.
    const nodeB = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
      cacheStore: shared,
      cache: { ttlSeconds: 60, key: (ctx) => `user:${ctx.user?.id}` },
    });
    await nodeB.invalidateByOrg("org1");

    // It cleared via the prefix pattern (NOT a per-key delete from a lost index),
    // and the shared store holds no org1 key — even though nodeB never saw it.
    expect(clearedPatterns).toContain("org1::*");
    expect([...store.keys()].some((k) => k.startsWith("org1::"))).toBe(false);
  });

  // ─── Cross-Node Event Invalidation ──────────────────────────────

  describe("connectEvents / disconnectEvents", () => {
    it("publishes event on invalidateByOrg when connected", async () => {
      const published: Array<{ type: string; payload: unknown }> = [];
      const mockEvents = {
        publish: async <T>(type: string, payload: T) => {
          published.push({ type, payload });
        },
        subscribe: async () => () => {},
      };

      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => roleMap,
        cache: { ttlSeconds: 60 },
      });

      // Before connect: no events
      await perms.invalidateByOrg("org-1");
      expect(published).toHaveLength(0);

      await perms.connectEvents(mockEvents);
      expect(perms.eventsConnected).toBe(true);

      await perms.invalidateByOrg("org-1");
      expect(published).toHaveLength(1);
      expect(published[0].type).toBe("arc.permissions.invalidated");
      expect((published[0].payload as any).orgId).toBe("org-1");
      expect((published[0].payload as any).nodeId).toBeDefined();

      await perms.disconnectEvents();
    });

    it("receives remote invalidation and clears local cache", async () => {
      let subscribeHandler: ((event: { payload: unknown }) => void) | null = null;
      const mockEvents = {
        publish: async () => {},
        subscribe: async (_pattern: string, handler: any) => {
          subscribeHandler = handler;
          return () => {};
        },
      };

      const resolver = vi.fn(async () => roleMap);
      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: resolver,
        cache: { ttlSeconds: 60 },
      });

      // Populate cache
      const check = perms.canAction("product", "create");
      await check(makeCtx({ orgId: "org-1", orgRoles: ["admin"] }));
      expect(resolver).toHaveBeenCalledTimes(1);

      await perms.connectEvents(mockEvents);

      // Simulate remote event (different nodeId)
      await subscribeHandler?.({ payload: { orgId: "org-1", nodeId: "remote-99" } });

      // Cache cleared — resolver called again
      await check(makeCtx({ orgId: "org-1", orgRoles: ["admin"] }));
      expect(resolver).toHaveBeenCalledTimes(2);

      await perms.disconnectEvents();
    });

    it("dedup: ignores events from own nodeId", async () => {
      let subscribeHandler: ((event: { payload: unknown }) => void) | null = null;
      const published: Array<{ payload: unknown }> = [];
      const mockEvents = {
        publish: async <T>(_type: string, payload: T) => {
          published.push({ payload });
        },
        subscribe: async (_pattern: string, handler: any) => {
          subscribeHandler = handler;
          return () => {};
        },
      };

      const resolver = vi.fn(async () => roleMap);
      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: resolver,
        cache: { ttlSeconds: 60 },
      });

      // Populate cache
      const check = perms.canAction("product", "create");
      await check(makeCtx({ orgId: "org-1", orgRoles: ["admin"] }));
      expect(resolver).toHaveBeenCalledTimes(1);

      await perms.connectEvents(mockEvents);

      // Publish to capture own nodeId
      await perms.invalidateByOrg("org-1");
      const ownNodeId = (published[0].payload as any).nodeId;

      // Re-populate cache
      resolver.mockClear();
      await check(makeCtx({ orgId: "org-1", orgRoles: ["admin"] }));
      expect(resolver).toHaveBeenCalledTimes(1);

      // Simulate receiving own echo — should be ignored
      await subscribeHandler?.({ payload: { orgId: "org-1", nodeId: ownNodeId } });

      resolver.mockClear();
      await check(makeCtx({ orgId: "org-1", orgRoles: ["admin"] }));
      expect(resolver).toHaveBeenCalledTimes(0); // still cached

      await perms.disconnectEvents();
    });

    it("calls onRemoteInvalidation callback on remote event", async () => {
      let subscribeHandler: ((event: { payload: unknown }) => void) | null = null;
      const remoteInvalidations: string[] = [];

      const mockEvents = {
        publish: async () => {},
        subscribe: async (_pattern: string, handler: any) => {
          subscribeHandler = handler;
          return () => {};
        },
      };

      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => roleMap,
        cache: { ttlSeconds: 60 },
      });

      await perms.connectEvents(mockEvents, {
        onRemoteInvalidation: (orgId) => {
          remoteInvalidations.push(orgId);
        },
      });

      await subscribeHandler?.({ payload: { orgId: "org-cb", nodeId: "remote-x" } });
      expect(remoteInvalidations).toEqual(["org-cb"]);

      await perms.disconnectEvents();
    });

    it("disconnectEvents stops publishing", async () => {
      let unsubscribed = false;
      const published: unknown[] = [];

      const mockEvents = {
        publish: async <T>(_type: string, payload: T) => {
          published.push(payload);
        },
        subscribe: async () => () => {
          unsubscribed = true;
        },
      };

      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => roleMap,
        cache: { ttlSeconds: 60 },
      });

      await perms.connectEvents(mockEvents);
      expect(perms.eventsConnected).toBe(true);

      await perms.disconnectEvents();
      expect(perms.eventsConnected).toBe(false);
      expect(unsubscribed).toBe(true);

      await perms.invalidateByOrg("org-1");
      expect(published).toHaveLength(0);
    });

    it("supports custom event type", async () => {
      const published: Array<{ type: string }> = [];
      const mockEvents = {
        publish: async <T>(type: string, _payload: T) => {
          published.push({ type });
        },
        subscribe: async () => () => {},
      };

      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => roleMap,
        cache: { ttlSeconds: 60 },
      });

      await perms.connectEvents(mockEvents, { eventType: "custom.policy.changed" });
      await perms.invalidateByOrg("org-1");

      expect(published[0].type).toBe("custom.policy.changed");

      await perms.disconnectEvents();
    });
  });
});

/**
 * Cache bookkeeping must stay bounded on a READ-MOSTLY node.
 *
 * `trackedKeys` / `orgKeyIndex` exist so `invalidateByOrg` can evict a
 * custom-keyed matrix that a prefix scan would miss. They are populated on cache
 * HIT as well as on write — a node that only ever reads a shared Redis cache
 * would otherwise hold nothing to invalidate. That makes the cap load-bearing:
 * while it lived in the write path, a node serving hits and rarely setting
 * accumulated one entry per distinct org/user/role combination it had ever seen,
 * for the process lifetime, outliving the cache entries themselves (the external
 * store expires those on its own schedule).
 */
describe("dynamic matrix — bookkeeping stays bounded on cache hits", () => {
  it("evicts tracked keys rather than accumulating one per org seen", async () => {
    const value = { admin: { product: ["create"] } };
    const deleted: string[] = [];
    // No `clear` on purpose: that forces `invalidateByOrg` down the per-key
    // fallback, which deletes exactly what the in-process index still tracks —
    // making the bookkeeping observable without exposing a diagnostic.
    const store = {
      get: async () => value,
      set: async () => {},
      delete: async (k: string) => {
        deleted.push(k);
      },
    } as unknown as CacheStore<Record<string, Record<string, readonly string[]>>>;

    const resolveRolePermissions = vi.fn(async () => value);
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions,
      cacheStore: store,
      cache: { ttlSeconds: 300, maxEntries: 25 },
    });
    const check = perms.can({ product: ["create"] });

    // Far more distinct orgs than the cap — every lookup a HIT, so the write
    // path (where the cap used to live) never runs.
    for (let i = 0; i < 400; i++) {
      await check(makeCtx({ orgId: `org-${i}`, orgRoles: ["admin"] }));
    }
    expect(resolveRolePermissions).not.toHaveBeenCalled();

    for (let i = 0; i < 400; i++) await perms.invalidateByOrg(`org-${i}`);

    // Bounded bookkeeping cannot still be tracking 400 orgs' keys. Before the
    // fix this was 400; the cap is 25.
    expect(deleted.length).toBeLessThanOrEqual(25);
  });
});
