import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDynamicPermissionMatrix,
  type PermissionContext,
} from '../../src/permissions/index.js';
import type { CacheStore } from '../../src/cache/interface.js';

/** Build a PermissionContext with scope on the request */
function makeCtx(overrides: {
  user?: Record<string, unknown> | null;
  orgId?: string;
  orgRoles?: string[];
  elevated?: boolean;
} = {}): PermissionContext {
  const req: Record<string, unknown> = {};

  if (overrides.elevated) {
    req.scope = { kind: 'elevated', elevatedBy: 'admin' };
  } else if (overrides.orgId || overrides.orgRoles) {
    req.scope = {
      kind: 'member',
      organizationId: overrides.orgId ?? '',
      orgRoles: overrides.orgRoles ?? [],
    };
  } else if (overrides.user !== null && overrides.user !== undefined) {
    req.scope = { kind: 'authenticated' };
  }

  return {
    user: overrides.user === undefined ? { id: 'u1', role: [] } : overrides.user,
    request: req as any,
    resource: 'product',
    action: 'create',
  };
}

describe('createDynamicPermissionMatrix', () => {
  const roleMap = {
    owner: { product: ['create', 'update', 'delete'], order: ['approve'] },
    admin: { product: ['create', 'update'] },
    viewer: { product: ['read'] },
  } as const;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('grants when org role has required permission', async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.can({ product: ['create'] });
    const result = await check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
    expect(result).toBe(true);
  });

  it('denies when org role lacks required permission', async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.can({ product: ['delete'] });
    const result = await check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
    expect(result).toEqual({
      granted: false,
      reason: 'Missing permission: product:delete',
    });
  });

  it('resolves union across multiple org roles', async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.can({ order: ['approve'] });
    const result = await check(makeCtx({ orgId: 'org1', orgRoles: ['viewer', 'owner'] }));
    expect(result).toBe(true);
  });

  it('supports wildcard resource and action', async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => ({
        support: { '*': ['read'] },
        super_ops: { '*': ['*'] },
      }),
    });

    const readAny = perms.canAction('invoice', 'read');
    const readResult = await readAny(makeCtx({ orgId: 'org1', orgRoles: ['support'] }));
    expect(readResult).toBe(true);

    const writeAny = perms.canAction('invoice', 'delete');
    const writeResult = await writeAny(makeCtx({ orgId: 'org1', orgRoles: ['super_ops'] }));
    expect(writeResult).toBe(true);
  });

  it('grants elevated scope regardless of permissions', async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => ({}),
    });

    const check = perms.canAction('product', 'delete');
    const result = await check(makeCtx({ elevated: true }));
    expect(result).toBe(true);
  });

  it('denies unauthenticated and missing org context', async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => roleMap,
    });

    const check = perms.canAction('product', 'create');

    const unauth = await check(makeCtx({ user: null }));
    expect(unauth).toEqual({ granted: false, reason: 'Authentication required' });

    const noOrg = await check(makeCtx({ user: { id: 'u1', role: [] } }));
    expect(noOrg).toEqual({ granted: false, reason: 'Organization membership required' });

    const noMembership = await check(makeCtx({ orgId: 'org1', orgRoles: [] }));
    expect(noMembership).toEqual({ granted: false, reason: 'Not a member of this organization' });
  });

  it('caches resolved matrix when cache ttl is enabled', async () => {
    const resolver = vi.fn(async () => roleMap);
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: resolver,
      cache: { ttlMs: 60_000 },
    });

    const check = perms.canAction('product', 'create');
    const ctx = makeCtx({ orgId: 'org1', orgRoles: ['admin'] });

    expect(await check(ctx)).toBe(true);
    expect(await check(ctx)).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);

    await perms.clearCache();
    expect(await check(ctx)).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('uses custom cache key when provided', async () => {
    const resolver = vi.fn(async () => roleMap);
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: resolver,
      cache: {
        ttlMs: 60_000,
        key: (ctx) => String((ctx.user as { id?: string } | null)?.id ?? 'anon'),
      },
    });

    const check = perms.canAction('product', 'create');
    expect(await check(makeCtx({ orgId: 'orgA', orgRoles: ['admin'], user: { id: 'u1', role: [] } }))).toBe(true);
    expect(await check(makeCtx({ orgId: 'orgB', orgRoles: ['admin'], user: { id: 'u1', role: [] } }))).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('denies with clear reason when matrix resolver throws', async () => {
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: async () => {
        throw new Error('DB unavailable');
      },
    });

    const check = perms.canAction('product', 'create');
    const result = await check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
    expect(result).toEqual({
      granted: false,
      reason: 'Permission matrix resolution failed: DB unavailable',
    });
  });

  it('uses external cache store adapter when provided', async () => {
    const get = vi.fn(async () => undefined as Record<string, Record<string, readonly string[]>> | undefined);
    const set = vi.fn(async () => {});
    const cacheStore: CacheStore<Record<string, Record<string, readonly string[]>>> = {
      name: 'mock-cache',
      get,
      set,
      delete: async () => {},
      clear: async () => {},
    };

    const resolver = vi.fn(async () => roleMap);
    const perms = createDynamicPermissionMatrix({
      resolveRolePermissions: resolver,
      cacheStore,
      cache: { ttlMs: 60_000 },
    });

    const check = perms.canAction('product', 'create');
    const result = await check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));

    expect(result).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  // ─── Cross-Node Event Invalidation ──────────────────────────────

  describe('connectEvents / disconnectEvents', () => {
    it('publishes event on invalidateByOrg when connected', async () => {
      const published: Array<{ type: string; payload: unknown }> = [];
      const mockEvents = {
        publish: async <T>(type: string, payload: T) => {
          published.push({ type, payload });
        },
        subscribe: async () => () => {},
      };

      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => roleMap,
        cache: { ttlMs: 60_000 },
      });

      // Before connect: no events
      await perms.invalidateByOrg('org-1');
      expect(published).toHaveLength(0);

      await perms.connectEvents(mockEvents);
      expect(perms.eventsConnected).toBe(true);

      await perms.invalidateByOrg('org-1');
      expect(published).toHaveLength(1);
      expect(published[0].type).toBe('arc.permissions.invalidated');
      expect((published[0].payload as any).orgId).toBe('org-1');
      expect((published[0].payload as any).nodeId).toBeDefined();

      await perms.disconnectEvents();
    });

    it('receives remote invalidation and clears local cache', async () => {
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
        cache: { ttlMs: 60_000 },
      });

      // Populate cache
      const check = perms.canAction('product', 'create');
      await check(makeCtx({ orgId: 'org-1', orgRoles: ['admin'] }));
      expect(resolver).toHaveBeenCalledTimes(1);

      await perms.connectEvents(mockEvents);

      // Simulate remote event (different nodeId)
      await subscribeHandler!({ payload: { orgId: 'org-1', nodeId: 'remote-99' } });

      // Cache cleared — resolver called again
      await check(makeCtx({ orgId: 'org-1', orgRoles: ['admin'] }));
      expect(resolver).toHaveBeenCalledTimes(2);

      await perms.disconnectEvents();
    });

    it('dedup: ignores events from own nodeId', async () => {
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
        cache: { ttlMs: 60_000 },
      });

      // Populate cache
      const check = perms.canAction('product', 'create');
      await check(makeCtx({ orgId: 'org-1', orgRoles: ['admin'] }));
      expect(resolver).toHaveBeenCalledTimes(1);

      await perms.connectEvents(mockEvents);

      // Publish to capture own nodeId
      await perms.invalidateByOrg('org-1');
      const ownNodeId = (published[0].payload as any).nodeId;

      // Re-populate cache
      resolver.mockClear();
      await check(makeCtx({ orgId: 'org-1', orgRoles: ['admin'] }));
      expect(resolver).toHaveBeenCalledTimes(1);

      // Simulate receiving own echo — should be ignored
      await subscribeHandler!({ payload: { orgId: 'org-1', nodeId: ownNodeId } });

      resolver.mockClear();
      await check(makeCtx({ orgId: 'org-1', orgRoles: ['admin'] }));
      expect(resolver).toHaveBeenCalledTimes(0); // still cached

      await perms.disconnectEvents();
    });

    it('calls onRemoteInvalidation callback on remote event', async () => {
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
        cache: { ttlMs: 60_000 },
      });

      await perms.connectEvents(mockEvents, {
        onRemoteInvalidation: (orgId) => { remoteInvalidations.push(orgId); },
      });

      await subscribeHandler!({ payload: { orgId: 'org-cb', nodeId: 'remote-x' } });
      expect(remoteInvalidations).toEqual(['org-cb']);

      await perms.disconnectEvents();
    });

    it('disconnectEvents stops publishing', async () => {
      let unsubscribed = false;
      const published: unknown[] = [];

      const mockEvents = {
        publish: async <T>(_type: string, payload: T) => { published.push(payload); },
        subscribe: async () => () => { unsubscribed = true; },
      };

      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => roleMap,
        cache: { ttlMs: 60_000 },
      });

      await perms.connectEvents(mockEvents);
      expect(perms.eventsConnected).toBe(true);

      await perms.disconnectEvents();
      expect(perms.eventsConnected).toBe(false);
      expect(unsubscribed).toBe(true);

      await perms.invalidateByOrg('org-1');
      expect(published).toHaveLength(0);
    });

    it('supports custom event type', async () => {
      const published: Array<{ type: string }> = [];
      const mockEvents = {
        publish: async <T>(type: string, _payload: T) => { published.push({ type }); },
        subscribe: async () => () => {},
      };

      const perms = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => roleMap,
        cache: { ttlMs: 60_000 },
      });

      await perms.connectEvents(mockEvents, { eventType: 'custom.policy.changed' });
      await perms.invalidateByOrg('org-1');

      expect(published[0].type).toBe('custom.policy.changed');

      await perms.disconnectEvents();
    });
  });
});
