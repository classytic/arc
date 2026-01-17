/**
 * Slug Lookup Preset Tests
 *
 * Tests the slug lookup preset configuration including:
 * - Route addition (GET /slug/:slug)
 * - Controller options (slugField)
 * - Permission inheritance
 */

import { describe, it, expect } from 'vitest';
import { slugLookupPreset } from '../../src/presets/slugLookup.js';
import { applyPresets } from '../../src/presets/index.js';
import type { ResourceConfig, ResourcePermissions } from '../../src/types/index.js';
import { allowPublic, requireRoles } from '../../src/permissions/index.js';

describe('slugLookup preset', () => {
  describe('Preset configuration', () => {
    it('should return correct preset name', () => {
      const result = slugLookupPreset();
      expect(result.name).toBe('slugLookup');
    });

    it('should add GET /slug/:slug route with default slug field', () => {
      const result = slugLookupPreset();
      const permissions: ResourcePermissions = { get: allowPublic() };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const slugRoute = routes.find(r => r.path.includes('/slug/'));
      expect(slugRoute).toBeDefined();
      expect(slugRoute?.method).toBe('GET');
      expect(slugRoute?.path).toBe('/slug/:slug');
      expect(slugRoute?.handler).toBe('getBySlug');
    });

    it('should use get permission for slug route', () => {
      const result = slugLookupPreset();
      const getPermission = requireRoles(['user', 'admin']);
      const permissions: ResourcePermissions = { get: getPermission };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const slugRoute = routes.find(r => r.path.includes('/slug/'));
      expect(slugRoute?.permissions).toBe(getPermission);
    });

    it('should default to allowPublic if get permission not defined', () => {
      const result = slugLookupPreset();
      const permissions: ResourcePermissions = {};

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const slugRoute = routes.find(r => r.path.includes('/slug/'));
      expect(slugRoute?.permissions).toBeDefined();
      expect(typeof slugRoute?.permissions).toBe('function');
    });

    it('should provide controllerOptions with slugField', () => {
      const result = slugLookupPreset();
      expect(result.controllerOptions).toBeDefined();
      expect(result.controllerOptions?.slugField).toBe('slug');
    });
  });

  describe('Custom slug field', () => {
    it('should support custom slug field name', () => {
      const result = slugLookupPreset({ slugField: 'permalink' });
      const permissions: ResourcePermissions = { get: allowPublic() };

      const routes = typeof result.additionalRoutes === 'function'
        ? result.additionalRoutes(permissions)
        : result.additionalRoutes || [];

      const slugRoute = routes.find(r => r.path.includes('/slug/'));
      expect(slugRoute?.path).toBe('/slug/:permalink');
    });

    it('should pass custom slugField to controller options', () => {
      const result = slugLookupPreset({ slugField: 'permalink' });
      expect(result.controllerOptions?.slugField).toBe('permalink');
    });
  });

  describe('Preset application', () => {
    it('should apply preset to resource config', () => {
      const baseConfig: ResourceConfig = {
        name: 'article',
        permissions: { get: allowPublic() },
        presets: ['slugLookup'],
      };

      const result = applyPresets(baseConfig, ['slugLookup']);

      // Should have additional routes added
      expect(result.additionalRoutes).toBeDefined();
      const routePaths = result.additionalRoutes?.map(r => r.path) || [];
      expect(routePaths.some(p => p.includes('/slug/'))).toBe(true);
    });

    it('should merge controller options', () => {
      const baseConfig: ResourceConfig = {
        name: 'article',
        permissions: { get: allowPublic() },
        presets: [{ name: 'slugLookup', slugField: 'handle' }],
      };

      const result = applyPresets(baseConfig, [{ name: 'slugLookup', slugField: 'handle' }]);

      // Check if controller options were passed
      expect(result._controllerOptions?.slugField).toBe('handle');
    });
  });
});
