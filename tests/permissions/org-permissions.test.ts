/**
 * Organization Permission Tests
 *
 * Tests requireOrgMembership, requireOrgRole, and createOrgPermissions.
 * All functions read `request.scope` (set by auth adapters).
 */

import { describe, it, expect } from 'vitest';
import {
  requireOrgMembership,
  requireOrgRole,
  createOrgPermissions,
  anyOf,
  requireRoles,
  roles,
  type PermissionContext,
} from '../../src/permissions/index.js';

// ============================================================================
// Helpers
// ============================================================================

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
    const result = check(makeCtx({ user: { id: 'u1', role: [] } }));
    expect(result).toEqual({ granted: false, reason: 'Organization membership required' });
  });

  it('grants when org set even with no roles (membership means scope is member)', () => {
    const result = check(makeCtx({ orgId: 'org1', orgRoles: [] }));
    expect(result).toBe(true);
  });

  it('grants when user is a member', () => {
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['member'] }));
    expect(result).toBe(true);
  });

  it('grants elevated scope without org context', () => {
    const result = check(makeCtx({ elevated: true }));
    expect(result).toBe(true);
  });

  it('grants when user has multiple org roles (multi-role membership)', () => {
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin', 'recruiter'] }));
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

  it('grants with elevated scope', () => {
    const check = requireOrgRole('owner');
    const result = check(makeCtx({ elevated: true }));
    expect(result).toBe(true);
  });

  it('denies when no active organization', () => {
    const check = requireOrgRole('admin');
    const result = check(makeCtx());
    expect(result).toEqual({ granted: false, reason: 'Organization membership required' });
  });

  // ──────────────────────────────────────────────────────────────
  // Multi-role support (Better Auth comma-separated → string[])
  // Better Auth stores roles as "admin,recruiter" → adapter splits
  // to ['admin', 'recruiter']. requireOrgRole uses .some() so ANY
  // matching role grants access.
  // ──────────────────────────────────────────────────────────────

  it('grants when user has multiple roles and one matches', () => {
    const check = requireOrgRole('admin');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['recruiter', 'admin'] }));
    expect(result).toBe(true);
  });

  it('grants when user has multiple roles and second role matches', () => {
    const check = requireOrgRole('delivery_manager');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin', 'delivery_manager'] }));
    expect(result).toBe(true);
  });

  it('denies when user has multiple roles but none match', () => {
    const check = requireOrgRole('owner');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin', 'member'] }));
    expect(result).toEqual({ granted: false, reason: 'Required org roles: owner' });
  });

  it('grants with multiple required roles when user has one matching', () => {
    const check = requireOrgRole('admin', 'delivery_manager');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['recruiter', 'delivery_manager'] }));
    expect(result).toBe(true);
  });

  it('handles real-world AI-Hire role combinations', () => {
    // account_manager + recruiter combo
    const check = requireOrgRole('admin', 'account_manager', 'recruiter');
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['account_manager', 'recruiter'] }));
    expect(result).toBe(true);
  });

  it('works with anyOf combinator', async () => {
    const combined = anyOf(
      requireOrgRole('admin'),
      requireRoles(['superadmin']),
    );

    // Global superadmin should pass via requireRoles
    const result = await combined(makeCtx({ user: { id: 'u1', role: ['superadmin'] } }));
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

    it('grants elevated scope regardless of org permissions', () => {
      const check = perms.can({ product: ['delete'] });
      const result = check(makeCtx({ elevated: true }));
      expect(result).toBe(true);
    });

    it('resolves union of multiple roles', () => {
      const check = perms.can({ product: ['delete'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin', 'owner'] }));
      expect(result).toBe(true);
    });

    it('multi-role: admin+member gets admin permissions via union', () => {
      const check = perms.can({ product: ['create', 'update'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin', 'member'] }));
      expect(result).toBe(true);
    });

    it('multi-role: member+admin union grants delete via owner-only perm', () => {
      const check = perms.can({ product: ['delete'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['member', 'owner'] }));
      expect(result).toBe(true);
    });

    it('multi-role: member+admin union does NOT grant delete (neither has it)', () => {
      const check = perms.can({ product: ['delete'] });
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin', 'member'] }));
      expect(result).toEqual({
        granted: false,
        reason: 'Missing permissions: product:[delete]',
      });
    });

    it('denies when no active organization', () => {
      const check = perms.can({ product: ['create'] });
      const result = check(makeCtx());
      expect(result).toEqual({ granted: false, reason: 'Organization membership required' });
    });

    it('denies unauthenticated users', () => {
      const check = perms.can({ product: ['create'] });
      const result = check(makeCtx({ user: null }));
      expect(result).toEqual({ granted: false, reason: 'Authentication required' });
    });
  });

  describe('requireRole()', () => {
    it('delegates to requireOrgRole', () => {
      const check = perms.requireRole('admin');
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['admin'] }));
      expect(result).toBe(true);
    });
  });

  describe('requireMembership()', () => {
    it('delegates to requireOrgMembership', () => {
      const check = perms.requireMembership();
      const result = check(makeCtx({ orgId: 'org1', orgRoles: ['member'] }));
      expect(result).toBe(true);
    });
  });
});

// ============================================================================
// roles() — unified helper (platform + org)
// ============================================================================

describe('roles() — unified platform + org check', () => {
  it('grants when platform role matches', () => {
    const check = roles('admin');
    const result = check(makeCtx({ user: { id: 'u1', role: 'admin' } }));
    expect(result).toBe(true);
  });

  it('grants when org role matches (platform role does not)', () => {
    const check = roles('admin');
    // user.role is 'user' (not admin), but org membership is 'admin'
    const result = check(makeCtx({
      user: { id: 'u1', role: 'user' },
      orgId: 'org1',
      orgRoles: ['admin'],
    }));
    expect(result).toBe(true);
  });

  it('denies when neither platform nor org role matches', () => {
    const check = roles('admin');
    const result = check(makeCtx({
      user: { id: 'u1', role: 'user' },
      orgId: 'org1',
      orgRoles: ['member'],
    }));
    expect(result).toEqual({ granted: false, reason: 'Required roles: admin' });
  });

  it('grants elevated scope always', () => {
    const check = roles('admin');
    const result = check(makeCtx({ elevated: true }));
    expect(result).toBe(true);
  });

  it('denies unauthenticated', () => {
    const check = roles('admin');
    const result = check(makeCtx({ user: null }));
    expect(result).toEqual({ granted: false, reason: 'Authentication required' });
  });

  it('supports multiple roles (any match)', () => {
    const check = roles('admin', 'editor');
    const result = check(makeCtx({
      user: { id: 'u1', role: 'viewer' },
      orgId: 'org1',
      orgRoles: ['editor'],
    }));
    expect(result).toBe(true);
  });

  it('supports array argument form', () => {
    const check = roles(['owner', 'admin']);
    const result = check(makeCtx({ orgId: 'org1', orgRoles: ['owner'] }));
    expect(result).toBe(true);
  });

  it('works without org context (authenticated only)', () => {
    const check = roles('admin');
    // No org, just platform role
    const result = check(makeCtx({ user: { id: 'u1', role: 'admin' } }));
    expect(result).toBe(true);
  });
});

// ============================================================================
// requireRoles({ includeOrgRoles })
// ============================================================================

describe('requireRoles with includeOrgRoles option', () => {
  it('default: does NOT check org roles', () => {
    const check = requireRoles(['admin']);
    const result = check(makeCtx({
      user: { id: 'u1', role: 'user' },
      orgId: 'org1',
      orgRoles: ['admin'],
    }));
    // Should DENY — org role 'admin' not checked by default
    expect(result).toEqual({ granted: false, reason: 'Required roles: admin' });
  });

  it('includeOrgRoles: true checks org roles too', () => {
    const check = requireRoles(['admin'], { includeOrgRoles: true });
    const result = check(makeCtx({
      user: { id: 'u1', role: 'user' },
      orgId: 'org1',
      orgRoles: ['admin'],
    }));
    expect(result).toBe(true);
  });

  it('includeOrgRoles: true still checks platform roles first', () => {
    const check = requireRoles(['admin'], { includeOrgRoles: true });
    const result = check(makeCtx({ user: { id: 'u1', role: 'admin' } }));
    expect(result).toBe(true);
  });

  it('includeOrgRoles: true denies when neither level has the role', () => {
    const check = requireRoles(['admin'], { includeOrgRoles: true });
    const result = check(makeCtx({
      user: { id: 'u1', role: 'user' },
      orgId: 'org1',
      orgRoles: ['member'],
    }));
    expect(result).toEqual({ granted: false, reason: 'Required roles: admin' });
  });
});
