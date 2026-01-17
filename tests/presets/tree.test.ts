/**
 * Tree Preset Tests
 *
 * Tests the tree preset configuration including:
 * - Route addition (GET /tree, GET /:parent/children)
 * - Controller options (parentField)
 * - Permission inheritance
 */

import { describe, it, expect } from 'vitest';
import { treePreset } from '../../src/presets/tree.js';
import { applyPresets } from '../../src/presets/index.js';
import type { ResourceConfig, ResourcePermissions } from '../../src/types/index.js';
import { allowPublic, requireRoles } from '../../src/permissions/index.js';

describe('tree preset', () => {
  describe('Preset configuration', () => {
    it('should return correct preset name', () => {
      const result = treePreset();
      expect(result.name).toBe('tree');
    });

    it('should add GET /tree route', () => {
      const result = treePreset();
      const permissions: ResourcePermissions = { list: allowPublic() };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const treeRoute = routes.find(r => r.path === '/tree');
      expect(treeRoute).toBeDefined();
      expect(treeRoute?.method).toBe('GET');
      expect(treeRoute?.handler).toBe('getTree');
    });

    it('should add GET /:parent/children route with default parent field', () => {
      const result = treePreset();
      const permissions: ResourcePermissions = { list: allowPublic() };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const childrenRoute = routes.find(r => r.path.includes('/children'));
      expect(childrenRoute).toBeDefined();
      expect(childrenRoute?.method).toBe('GET');
      expect(childrenRoute?.path).toBe('/:parent/children');
      expect(childrenRoute?.handler).toBe('getChildren');
    });

    it('should use list permission for /tree route', () => {
      const result = treePreset();
      const listPermission = requireRoles(['admin']);
      const permissions: ResourcePermissions = { list: listPermission };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const treeRoute = routes.find(r => r.path === '/tree');
      expect(treeRoute?.permissions).toBe(listPermission);
    });

    it('should fallback to allowPublic if list permission not defined', () => {
      const result = treePreset();
      const permissions: ResourcePermissions = {};

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const treeRoute = routes.find(r => r.path === '/tree');
      expect(treeRoute?.permissions).toBeDefined();
      // Permission should be a function
      expect(typeof treeRoute?.permissions).toBe('function');
    });

    it('should use list permission for children route', () => {
      const result = treePreset();
      const listPermission = requireRoles(['editor']);
      const permissions: ResourcePermissions = { list: listPermission };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const childrenRoute = routes.find(r => r.path.includes('/children'));
      expect(childrenRoute?.permissions).toBe(listPermission);
    });

    it('should provide controllerOptions with parentField', () => {
      const result = treePreset();
      expect(result.controllerOptions).toBeDefined();
      expect(result.controllerOptions?.parentField).toBe('parent');
    });
  });

  describe('Custom parent field', () => {
    it('should support custom parent field name', () => {
      const result = treePreset({ parentField: 'parentItem' });
      const permissions: ResourcePermissions = { list: allowPublic() };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const childrenRoute = routes.find(r => r.path.includes('/children'));
      expect(childrenRoute?.path).toBe('/:parentItem/children');
    });

    it('should pass custom parentField to controller options', () => {
      const result = treePreset({ parentField: 'parentItem' });
      expect(result.controllerOptions?.parentField).toBe('parentItem');
    });
  });

  describe('Preset application', () => {
    it('should apply preset to resource config', () => {
      const baseConfig: ResourceConfig = {
        name: 'category',
        permissions: { list: allowPublic() },
        presets: ['tree'],
      };

      const result = applyPresets(baseConfig, ['tree']);

      // Should have additional routes added
      expect(result.additionalRoutes).toBeDefined();
      const routePaths = result.additionalRoutes?.map(r => r.path) || [];
      expect(routePaths).toContain('/tree');
      expect(routePaths.some(p => p.includes('/children'))).toBe(true);
    });

    it('should merge controller options', () => {
      const baseConfig: ResourceConfig = {
        name: 'category',
        permissions: { list: allowPublic() },
        presets: [{ name: 'tree', parentField: 'parentCategory' }],
      };

      const result = applyPresets(baseConfig, [{ name: 'tree', parentField: 'parentCategory' }]);

      expect(result._controllerOptions?.parentField).toBe('parentCategory');
    });
  });
});
