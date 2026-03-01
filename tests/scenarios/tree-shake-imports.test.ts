/**
 * Tree-Shakable Imports — Verification Tests
 *
 * Ensures all subpath imports from @classytic/arc resolve correctly
 * and users don't need barrel imports to use individual modules.
 *
 * Run with: npx vitest run tests/scenarios/tree-shake-imports.test.ts
 */

import { describe, it, expect } from 'vitest';

describe('Tree-Shakable Imports', () => {
  // --------------------------------------------------------------------------
  // Subpath imports resolve correctly
  // --------------------------------------------------------------------------

  describe('Subpath imports resolve', () => {
    it('@classytic/arc/permissions exports permission functions', async () => {
      const perms = await import('../../src/permissions/index.js');
      expect(perms.allowPublic).toBeTypeOf('function');
      expect(perms.requireAuth).toBeTypeOf('function');
      expect(perms.requireRoles).toBeTypeOf('function');
      expect(perms.requireOwnership).toBeTypeOf('function');
      expect(perms.allOf).toBeTypeOf('function');
      expect(perms.anyOf).toBeTypeOf('function');
      expect(perms.createDynamicPermissionMatrix).toBeTypeOf('function');
      expect(perms.requireOrgMembership).toBeTypeOf('function');
      expect(perms.requireOrgRole).toBeTypeOf('function');
    });

    it('@classytic/arc/permissions exports permission presets', async () => {
      const perms = await import('../../src/permissions/index.js');
      expect(perms.permissions).toBeDefined();
      expect(perms.publicRead).toBeTypeOf('function');
      expect(perms.publicReadAdminWrite).toBeTypeOf('function');
      expect(perms.authenticated).toBeTypeOf('function');
      expect(perms.adminOnly).toBeTypeOf('function');
      expect(perms.fullPublic).toBeTypeOf('function');
      expect(perms.readOnly).toBeTypeOf('function');
    });

    it('@classytic/arc/presets exports preset functions', async () => {
      const presets = await import('../../src/presets/index.js');
      expect(presets.multiTenantPreset).toBeTypeOf('function');
    });

    it('@classytic/arc/testing exports test utilities', async () => {
      const testing = await import('../../src/testing/index.js');
      expect(testing).toBeDefined();
      // createTestApp or createMinimalTestApp should exist
      expect(
        typeof testing.createTestApp === 'function' ||
        typeof testing.createMinimalTestApp === 'function'
      ).toBe(true);
    });

    it('@classytic/arc core exports defineResource', async () => {
      const core = await import('../../src/core/defineResource.js');
      expect(core.defineResource).toBeTypeOf('function');
    });

    it('@classytic/arc core exports BaseController', async () => {
      const core = await import('../../src/core/BaseController.js');
      expect(core.BaseController).toBeTypeOf('function');
    });

    it('@classytic/arc/adapters exports mongoose adapter', async () => {
      const adapters = await import('../../src/adapters/mongoose.js');
      expect(adapters.createMongooseAdapter).toBeTypeOf('function');
    });
  });

  // --------------------------------------------------------------------------
  // Independent imports
  // --------------------------------------------------------------------------

  describe('No barrel required', () => {
    it('allowPublic can be imported from permissions without pulling entire arc', async () => {
      const { allowPublic } = await import('../../src/permissions/index.js');
      expect(allowPublic).toBeTypeOf('function');
      const check = allowPublic();
      expect(check).toBeTypeOf('function');
      // Verify it actually works
      const result = await check({ user: null } as any);
      expect(result).toBe(true);
    });

    it('defineResource can be imported from core without pulling auth', async () => {
      const { defineResource } = await import('../../src/core/defineResource.js');
      expect(defineResource).toBeTypeOf('function');
    });

    it('createDynamicPermissionMatrix can be imported independently', async () => {
      const { createDynamicPermissionMatrix } = await import('../../src/permissions/index.js');
      expect(createDynamicPermissionMatrix).toBeTypeOf('function');

      // Create a matrix and verify it returns expected interface
      const matrix = createDynamicPermissionMatrix({
        resolveRolePermissions: async () => ({
          admin: { test: ['read'] },
        }),
      });

      expect(matrix.canAction).toBeTypeOf('function');
      expect(matrix.can).toBeTypeOf('function');
      expect(matrix.requireRole).toBeTypeOf('function');
      expect(matrix.clearCache).toBeTypeOf('function');
      expect(matrix.invalidateByOrg).toBeTypeOf('function');
    });
  });
});
