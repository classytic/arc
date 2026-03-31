/**
 * Role Hierarchy Tests
 *
 * TDD tests for createRoleHierarchy() — a composable utility that expands
 * roles based on an inheritance map. Users apply it at scope-building time;
 * requireRoles() works with the already-expanded list.
 */

import { describe, it, expect } from 'vitest';
import { createRoleHierarchy } from '../../src/permissions/roleHierarchy.js';

// ============================================================================
// Basic expansion
// ============================================================================

describe('createRoleHierarchy', () => {
  const hierarchy = createRoleHierarchy({
    superadmin: ['admin'],
    admin: ['branch_manager'],
    branch_manager: ['member'],
  });

  it('should expand a single role through the chain', () => {
    // superadmin inherits admin → branch_manager → member
    expect(hierarchy.expand(['superadmin'])).toEqual(
      expect.arrayContaining(['superadmin', 'admin', 'branch_manager', 'member']),
    );
  });

  it('should expand admin to include branch_manager and member', () => {
    const expanded = hierarchy.expand(['admin']);
    expect(expanded).toContain('admin');
    expect(expanded).toContain('branch_manager');
    expect(expanded).toContain('member');
    expect(expanded).not.toContain('superadmin');
  });

  it('should not expand a leaf role', () => {
    expect(hierarchy.expand(['member'])).toEqual(['member']);
  });

  it('should handle a role not in the hierarchy', () => {
    expect(hierarchy.expand(['unknown_role'])).toEqual(['unknown_role']);
  });

  it('should deduplicate when multiple roles expand to the same role', () => {
    // Both superadmin and admin expand to include branch_manager
    const expanded = hierarchy.expand(['superadmin', 'admin']);
    const uniqueCount = new Set(expanded).size;
    expect(expanded).toHaveLength(uniqueCount); // no duplicates
  });

  it('should handle empty input', () => {
    expect(hierarchy.expand([])).toEqual([]);
  });
});

// ============================================================================
// includes() helper
// ============================================================================

describe('hierarchy.includes', () => {
  const hierarchy = createRoleHierarchy({
    superadmin: ['admin'],
    admin: ['editor'],
    editor: ['viewer'],
  });

  it('should return true when user has exact role', () => {
    expect(hierarchy.includes(['editor'], 'editor')).toBe(true);
  });

  it('should return true when user has parent role', () => {
    expect(hierarchy.includes(['admin'], 'editor')).toBe(true);
    expect(hierarchy.includes(['admin'], 'viewer')).toBe(true);
    expect(hierarchy.includes(['superadmin'], 'viewer')).toBe(true);
  });

  it('should return false when user has child role only', () => {
    expect(hierarchy.includes(['editor'], 'admin')).toBe(false);
    expect(hierarchy.includes(['viewer'], 'superadmin')).toBe(false);
  });

  it('should return false for empty roles', () => {
    expect(hierarchy.includes([], 'admin')).toBe(false);
  });
});

// ============================================================================
// Multiple inheritance (diamond)
// ============================================================================

describe('diamond inheritance', () => {
  const hierarchy = createRoleHierarchy({
    superadmin: ['admin', 'finance-admin'],
    admin: ['member'],
    'finance-admin': ['member'],
  });

  it('should handle diamond — member only appears once', () => {
    const expanded = hierarchy.expand(['superadmin']);
    expect(expanded).toContain('superadmin');
    expect(expanded).toContain('admin');
    expect(expanded).toContain('finance-admin');
    expect(expanded).toContain('member');
    // No duplicates
    expect(expanded).toHaveLength(new Set(expanded).size);
  });
});

// ============================================================================
// Circular reference protection
// ============================================================================

describe('circular reference protection', () => {
  it('should not infinite-loop on circular hierarchy', () => {
    const hierarchy = createRoleHierarchy({
      a: ['b'],
      b: ['c'],
      c: ['a'], // circular!
    });

    // Should terminate and include all roles in the cycle
    const expanded = hierarchy.expand(['a']);
    expect(expanded).toContain('a');
    expect(expanded).toContain('b');
    expect(expanded).toContain('c');
    expect(expanded).toHaveLength(3);
  });
});

// ============================================================================
// Empty hierarchy
// ============================================================================

describe('empty hierarchy', () => {
  it('should work with no hierarchy defined', () => {
    const hierarchy = createRoleHierarchy({});
    expect(hierarchy.expand(['admin'])).toEqual(['admin']);
    expect(hierarchy.includes(['admin'], 'admin')).toBe(true);
    expect(hierarchy.includes(['admin'], 'editor')).toBe(false);
  });
});
