/**
 * Organization Permission Tests
 *
 * Tests requireOrgMembership, requireOrgRole, and createOrgPermissions.
 */

import { describe, it, expect } from 'vitest';
import {
  requireOrgMembership,
  requireOrgRole,
  createOrgPermissions,
  anyOf,
  requireRoles,
  type PermissionContext,
} from '../../src/permissions/index.js';

// ============================================================================
// Helpers
// ============================================================================

/** Build a PermissionContext with org context on the request */
function makeCtx(overrides: {
  user?: Record<string, unknown> | null;
  orgId?: string;
  orgRoles?: string[];
  orgScope?: string;
} = {}): PermissionContext {
  const req: Record<string, unknown> = {};
  if (overrides.orgId || overrides.orgRoles || overrides.orgScope) {
    req.organizationId = overrides.orgId;
    req.context = {
      organizationId: overrides.orgId,
      orgRoles: overrides.orgRoles ?? [],
      orgScope: overrides.orgScope ?? 'member',
    };
  }

  return {
    user: overrides.user === undefined ? { id: 'u1', roles: [] } : overrides.user,
    request: req as any,
    resource: 'product',
    action: 'create',
  };
}

// ============================================================================
// requireOrgMembership
// ============================================================================

describe('requireOrgMembership', () => {
  const check = requireOrgMembership();

  it('denies unauthenticated users', () => {
    const result = check(makeCtx({ user: null }));
    expect(result).toEqual({ granted: false, reason: 'Authentication required' });
  });

  it('denies when no active organization', () => {
    const result = check(makeCtx({ user: { id: 'u1', roles: [] } }));
    expect(result).toEqual({ granted: false, reason: 'No active organization' });
  });

  it('denies when org set but no roles (not a member)', () => {
    const result = check(makeCtx({ orgId: 'org1', orgRoles: [] }));
    expect(result).toEqual({ granted: false, reason: 'Not a member of this organization' });
  });

  it('grants when user is a member', () => {
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['member'] }));
    expect(result).toBe(true);
  });

  it('grants bypass role users without org context', () => {
    const bypassCheck = requireOrgMembership({ bypassRoles: ['superadmin'] });
    const result = bypassCheck(makeCtx({ user: { id: 'u1', roles: ['superadmin'] } }));
    expect(result).toBe(true);
  });

  it('grants when orgScope is bypass', () => {
    const result = check(makeCtx({ orgId: 'org1', orgRoles: [], orgScope: 'bypass' }));
    expect(result).toBe(true);
  });
});

// ============================================================================
// requireOrgRole
// ============================================================================

describe('requireOrgRole', () => {
  it('denies unauthenticated users', () => {
    const check = requireOrgRole('admin');
    const result = check(makeCtx({ user: null }));
    expect(result).toEqual({ granted: false, reason: 'Authentication required' });
  });

  it('denies when user has wrong org role', () => {
    const check = requireOrgRole('admin', 'owner');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['member'] }));
    expect(result).toEqual({ granted: false, reason: 'Required org roles: admin, owner' });
  });

  it('grants when user has matching org role', () => {
    const check = requireOrgRole('admin', 'owner');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
    expect(result).toBe(true);
  });

  it('grants with bypass scope', () => {
    const check = requireOrgRole('owner');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: [], orgScope: 'bypass' }));
    expect(result).toBe(true);
  });

  it('supports array + options overload', () => {
    const check = requireOrgRole(['admin'], { bypassRoles: ['superadmin'] });
    const result = check(makeCtx({ user: { id: 'u1', roles: ['superadmin'] } }));
    expect(result).toBe(true);
  });

  it('denies when no active organization', () => {
    const check = requireOrgRole('admin');
    const result = check(makeCtx());
    expect(result).toEqual({ granted: false, reason: 'No active organization' });
  });

  it('works with anyOf combinator', async () => {
    const combined = anyOf(
      requireOrgRole('admin'),
      requireRoles(['superadmin']),
    );

    // Global superadmin should pass via requireRoles
    const result = await combined(makeCtx({ user: { id: 'u1', roles: ['superadmin'] } }));
    const norm1 = typeof result === 'boolean' ? { granted: result } : result;
    expect(norm1.granted).toBe(true);

    // Org admin should pass via requireOrgRole
    const result2 = await combined(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
    const norm2 = typeof result2 === 'boolean' ? { granted: result2 } : result2;
    expect(norm2.granted).toBe(true);
  });
});

// ============================================================================
// createOrgPermissions
// ============================================================================

describe('createOrgPermissions', () => {
  const perms = createOrgPermissions({
    statements: {
      product: ['create', 'update', 'delete'],
      order: ['create', 'approve'],
    },
    roles: {
      owner: { product: ['create', 'update', 'delete'], order: ['create', 'approve'] },
      admin: { product: ['create', 'update'], order: ['create'] },
      member: { product: [], order: [] },
    },
    bypassRoles: ['superadmin'],
  });

  describe('can()', () => {
    it('grants owner full product access', () => {
      const check = perms.can({ product: ['create', 'update', 'delete'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['owner'] }));
      expect(result).toBe(true);
    });

    it('grants admin partial product access', () => {
      const check = perms.can({ product: ['create', 'update'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
      expect(result).toBe(true);
    });

    it('denies admin delete permission', () => {
      const check = perms.can({ product: ['delete'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
      expect(result).toEqual({
        granted: false,
        reason: 'Missing permissions: product:[delete]',
      });
    });

    it('denies member all actions', () => {
      const check = perms.can({ product: ['create'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['member'] }));
      expect(result).toEqual({
        granted: false,
        reason: 'Missing permissions: product:[create]',
      });
    });

    it('grants bypass role regardless of org permissions', () => {
      const check = perms.can({ product: ['delete'] });
      const result = check(makeCtx({ user: { id: 'u1', roles: ['superadmin'] } }));
      expect(result).toBe(true);
    });

    it('resolves union of multiple roles', () => {
      // User with both admin and owner roles
      const check = perms.can({ product: ['delete'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin', 'owner'] }));
      expect(result).toBe(true);
    });

    it('denies when no active organization', () => {
      const check = perms.can({ product: ['create'] });
      const result = check(makeCtx());
      expect(result).toEqual({ granted: false, reason: 'No active organization' });
    });

    it('denies unauthenticated users', () => {
      const check = perms.can({ product: ['create'] });
      const result = check(makeCtx({ user: null }));
      expect(result).toEqual({ granted: false, reason: 'Authentication required' });
    });
  });

  describe('requireRole()', () => {
    it('delegates to requireOrgRole with bypass roles', () => {
      const check = perms.requireRole('admin');
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
      expect(result).toBe(true);
    });
  });

  describe('requireMembership()', () => {
    it('delegates to requireOrgMembership with bypass roles', () => {
      const check = perms.requireMembership();
      const result = check(makeCtx({ user: { id: 'u1', roles: ['superadmin'] } }));
      expect(result).toBe(true);
    });
  });
});
