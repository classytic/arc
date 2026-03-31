/**
 * Scope Identity Tests — userId and userRoles on RequestScope
 *
 * TDD tests for adding userId and userRoles to the RequestScope discriminated union.
 * These fields close the gap where consumers had to dig into request.user manually.
 */

import { describe, it, expect } from 'vitest';
import {
  isMember,
  isElevated,
  isAuthenticated,
  getOrgId,
  getOrgRoles,
  getTeamId,
  getUserId,
  getUserRoles,
  PUBLIC_SCOPE,
  AUTHENTICATED_SCOPE,
} from '../../src/scope/types.js';
import type { RequestScope } from '../../src/scope/types.js';

// ============================================================================
// getUserId — reads userId from scope
// ============================================================================

describe('getUserId', () => {
  it('should return undefined for public scope', () => {
    expect(getUserId(PUBLIC_SCOPE)).toBeUndefined();
  });

  it('should return userId from authenticated scope', () => {
    const scope: RequestScope = { kind: 'authenticated', userId: 'user_123' };
    expect(getUserId(scope)).toBe('user_123');
  });

  it('should return userId from member scope', () => {
    const scope: RequestScope = {
      kind: 'member',
      userId: 'user_456',
      organizationId: 'org_1',
      orgRoles: ['admin'],
      userRoles: ['superadmin'],
    };
    expect(getUserId(scope)).toBe('user_456');
  });

  it('should return userId from elevated scope', () => {
    const scope: RequestScope = {
      kind: 'elevated',
      userId: 'user_789',
      elevatedBy: 'user_789',
    };
    expect(getUserId(scope)).toBe('user_789');
  });

  it('should return undefined for AUTHENTICATED_SCOPE constant (no userId)', () => {
    // The constant doesn't carry userId — backward compatibility
    expect(getUserId(AUTHENTICATED_SCOPE)).toBeUndefined();
  });
});

// ============================================================================
// getUserRoles — reads global userRoles from scope
// ============================================================================

describe('getUserRoles (scope accessor)', () => {
  it('should return empty array for public scope', () => {
    expect(getUserRoles(PUBLIC_SCOPE)).toEqual([]);
  });

  it('should return userRoles from authenticated scope', () => {
    const scope: RequestScope = {
      kind: 'authenticated',
      userId: 'user_1',
      userRoles: ['superadmin', 'finance-admin'],
    };
    expect(getUserRoles(scope)).toEqual(['superadmin', 'finance-admin']);
  });

  it('should return userRoles from member scope', () => {
    const scope: RequestScope = {
      kind: 'member',
      userId: 'user_2',
      organizationId: 'org_1',
      orgRoles: ['branch_manager'],
      userRoles: ['admin'],
    };
    expect(getUserRoles(scope)).toEqual(['admin']);
  });

  it('should return empty array from elevated scope (no userRoles field)', () => {
    const scope: RequestScope = {
      kind: 'elevated',
      userId: 'user_3',
      elevatedBy: 'user_3',
    };
    expect(getUserRoles(scope)).toEqual([]);
  });

  it('should return empty array when userRoles is not provided on member', () => {
    const scope: RequestScope = {
      kind: 'member',
      userId: 'user_4',
      organizationId: 'org_1',
      orgRoles: ['admin'],
      userRoles: [],
    };
    expect(getUserRoles(scope)).toEqual([]);
  });
});

// ============================================================================
// Existing accessors still work with extended scope
// ============================================================================

describe('existing scope accessors with userId/userRoles', () => {
  it('getOrgId still works on member with userId', () => {
    const scope: RequestScope = {
      kind: 'member',
      userId: 'u1',
      organizationId: 'org_1',
      orgRoles: ['admin'],
      userRoles: ['superadmin'],
    };
    expect(getOrgId(scope)).toBe('org_1');
  });

  it('getOrgRoles still works on member with userRoles', () => {
    const scope: RequestScope = {
      kind: 'member',
      userId: 'u1',
      organizationId: 'org_1',
      orgRoles: ['admin', 'editor'],
      userRoles: ['superadmin'],
    };
    expect(getOrgRoles(scope)).toEqual(['admin', 'editor']);
  });

  it('getTeamId still works', () => {
    const scope: RequestScope = {
      kind: 'member',
      userId: 'u1',
      organizationId: 'org_1',
      orgRoles: [],
      userRoles: [],
      teamId: 'team_1',
    };
    expect(getTeamId(scope)).toBe('team_1');
  });

  it('isMember still narrows correctly', () => {
    const scope: RequestScope = {
      kind: 'member',
      userId: 'u1',
      organizationId: 'org_1',
      orgRoles: ['admin'],
      userRoles: ['superadmin'],
    };
    expect(isMember(scope)).toBe(true);
    if (isMember(scope)) {
      expect(scope.organizationId).toBe('org_1');
      expect(scope.userId).toBe('u1');
      expect(scope.userRoles).toEqual(['superadmin']);
    }
  });

  it('isElevated still narrows correctly', () => {
    const scope: RequestScope = {
      kind: 'elevated',
      userId: 'u1',
      elevatedBy: 'u1',
      organizationId: 'org_1',
    };
    expect(isElevated(scope)).toBe(true);
    if (isElevated(scope)) {
      expect(scope.elevatedBy).toBe('u1');
      expect(scope.userId).toBe('u1');
    }
  });

  it('isAuthenticated returns true for all non-public scopes', () => {
    expect(isAuthenticated({ kind: 'authenticated', userId: 'u1' })).toBe(true);
    expect(isAuthenticated({ kind: 'member', userId: 'u1', organizationId: 'o1', orgRoles: [], userRoles: [] })).toBe(true);
    expect(isAuthenticated({ kind: 'elevated', userId: 'u1', elevatedBy: 'u1' })).toBe(true);
    expect(isAuthenticated(PUBLIC_SCOPE)).toBe(false);
  });
});
