/**
 * OpenAPI Update Method Tests
 *
 * Tests OpenAPI spec generation with different `updateMethod` values (PATCH, PUT, both)
 * and verifies that `disabledRoutes` suppresses routes from the generated spec.
 *
 * Uses the `buildOpenApiSpec` function directly with RegistryEntry objects.
 */

import { describe, it, expect } from 'vitest';
import { buildOpenApiSpec } from '../../src/docs/openapi.js';
import type { RegistryEntry } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a minimal RegistryEntry for testing OpenAPI generation.
 */
function createRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: 'product',
    displayName: 'Product',
    tag: 'Products',
    prefix: '/products',
    presets: [],
    routes: [],
    plugin: null,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('OpenAPI updateMethod', () => {
  // --------------------------------------------------------------------------
  // Default: PATCH
  // --------------------------------------------------------------------------

  describe('default (PATCH)', () => {
    it('generates only patch operation for update route', () => {
      const resource = createRegistryEntry();
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath).toBeDefined();
      expect(itemPath.patch).toBeDefined();
      expect(itemPath.put).toBeUndefined();
    });

    it('patch operation has correct operationId and summary', () => {
      const resource = createRegistryEntry();
      const spec = buildOpenApiSpec([resource]);

      const patchOp = spec.paths['/products/{id}']?.patch;
      expect(patchOp?.operationId).toBe('product_update');
      expect(patchOp?.summary).toContain('Update');
      expect(patchOp?.summary).toContain('product');
    });

    it('patch operation includes request body with input schema ref', () => {
      const resource = createRegistryEntry();
      const spec = buildOpenApiSpec([resource]);

      const patchOp = spec.paths['/products/{id}']?.patch;
      expect(patchOp?.requestBody).toBeDefined();

      const bodySchema = (patchOp?.requestBody as any)?.content?.['application/json']?.schema;
      expect(bodySchema?.$ref).toBe('#/components/schemas/productInput');
    });
  });

  // --------------------------------------------------------------------------
  // Explicit PATCH
  // --------------------------------------------------------------------------

  describe('explicit PATCH', () => {
    it('generates only patch operation when updateMethod is PATCH', () => {
      const resource = createRegistryEntry({ updateMethod: 'PATCH' });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath.patch).toBeDefined();
      expect(itemPath.put).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // PUT
  // --------------------------------------------------------------------------

  describe('PUT', () => {
    it('generates only put operation when updateMethod is PUT', () => {
      const resource = createRegistryEntry({ updateMethod: 'PUT' });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath).toBeDefined();
      expect(itemPath.put).toBeDefined();
      expect(itemPath.patch).toBeUndefined();
    });

    it('put operation has correct operationId', () => {
      const resource = createRegistryEntry({ updateMethod: 'PUT' });
      const spec = buildOpenApiSpec([resource]);

      const putOp = spec.paths['/products/{id}']?.put;
      expect(putOp?.operationId).toBe('product_update');
    });

    it('put operation includes request body', () => {
      const resource = createRegistryEntry({ updateMethod: 'PUT' });
      const spec = buildOpenApiSpec([resource]);

      const putOp = spec.paths['/products/{id}']?.put;
      expect(putOp?.requestBody).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 'both'
  // --------------------------------------------------------------------------

  describe('both', () => {
    it('generates both put and patch operations when updateMethod is "both"', () => {
      const resource = createRegistryEntry({ updateMethod: 'both' });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath).toBeDefined();
      expect(itemPath.put).toBeDefined();
      expect(itemPath.patch).toBeDefined();
    });

    it('both operations have the same operationId', () => {
      const resource = createRegistryEntry({ updateMethod: 'both' });
      const spec = buildOpenApiSpec([resource]);

      const putOp = spec.paths['/products/{id}']?.put;
      const patchOp = spec.paths['/products/{id}']?.patch;

      expect(putOp?.operationId).toBe('product_update');
      expect(patchOp?.operationId).toBe('product_update');
    });

    it('both operations include request body', () => {
      const resource = createRegistryEntry({ updateMethod: 'both' });
      const spec = buildOpenApiSpec([resource]);

      expect(spec.paths['/products/{id}']?.put?.requestBody).toBeDefined();
      expect(spec.paths['/products/{id}']?.patch?.requestBody).toBeDefined();
    });

    it('both operations have the same tags', () => {
      const resource = createRegistryEntry({ updateMethod: 'both', tag: 'Products' });
      const spec = buildOpenApiSpec([resource]);

      const putOp = spec.paths['/products/{id}']?.put;
      const patchOp = spec.paths['/products/{id}']?.patch;

      expect(putOp?.tags).toEqual(['Products']);
      expect(patchOp?.tags).toEqual(['Products']);
    });
  });

  // --------------------------------------------------------------------------
  // disabledRoutes
  // --------------------------------------------------------------------------

  describe('disabledRoutes', () => {
    it('does not generate update route when update is disabled', () => {
      const resource = createRegistryEntry({
        disabledRoutes: ['update'],
      });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath).toBeDefined();
      // Update should be absent
      expect(itemPath.patch).toBeUndefined();
      expect(itemPath.put).toBeUndefined();
      // Get and delete should still be present
      expect(itemPath.get).toBeDefined();
      expect(itemPath.delete).toBeDefined();
    });

    it('does not generate list route when list is disabled', () => {
      const resource = createRegistryEntry({
        disabledRoutes: ['list'],
      });
      const spec = buildOpenApiSpec([resource]);

      const collectionPath = spec.paths['/products'];
      // If only list is disabled, create should still be present
      expect(collectionPath?.get).toBeUndefined();
      expect(collectionPath?.post).toBeDefined();
    });

    it('does not generate create route when create is disabled', () => {
      const resource = createRegistryEntry({
        disabledRoutes: ['create'],
      });
      const spec = buildOpenApiSpec([resource]);

      const collectionPath = spec.paths['/products'];
      expect(collectionPath?.post).toBeUndefined();
      expect(collectionPath?.get).toBeDefined();
    });

    it('does not generate get route when get is disabled', () => {
      const resource = createRegistryEntry({
        disabledRoutes: ['get'],
      });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath?.get).toBeUndefined();
      // Delete and update should still be present
      expect(itemPath?.delete).toBeDefined();
      expect(itemPath?.patch).toBeDefined();
    });

    it('does not generate delete route when delete is disabled', () => {
      const resource = createRegistryEntry({
        disabledRoutes: ['delete'],
      });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath?.delete).toBeUndefined();
      // Get and update should still be present
      expect(itemPath?.get).toBeDefined();
      expect(itemPath?.patch).toBeDefined();
    });

    it('does not generate any routes when all are disabled', () => {
      const resource = createRegistryEntry({
        disabledRoutes: ['list', 'get', 'create', 'update', 'delete'],
      });
      const spec = buildOpenApiSpec([resource]);

      expect(spec.paths['/products']).toBeUndefined();
      expect(spec.paths['/products/{id}']).toBeUndefined();
    });

    it('handles disableDefaultRoutes flag', () => {
      const resource = createRegistryEntry({
        disableDefaultRoutes: true,
      });
      const spec = buildOpenApiSpec([resource]);

      expect(spec.paths['/products']).toBeUndefined();
      expect(spec.paths['/products/{id}']).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // apiPrefix
  // --------------------------------------------------------------------------

  describe('apiPrefix', () => {
    it('prepends apiPrefix to all paths', () => {
      const resource = createRegistryEntry();
      const spec = buildOpenApiSpec([resource], { apiPrefix: '/api/v1' });

      expect(spec.paths['/api/v1/products']).toBeDefined();
      expect(spec.paths['/api/v1/products/{id}']).toBeDefined();
      expect(spec.paths['/products']).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Combined: updateMethod + disabledRoutes
  // --------------------------------------------------------------------------

  describe('updateMethod + disabledRoutes combined', () => {
    it('PUT + disabled update produces no update operation', () => {
      const resource = createRegistryEntry({
        updateMethod: 'PUT',
        disabledRoutes: ['update'],
      });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath?.put).toBeUndefined();
      expect(itemPath?.patch).toBeUndefined();
    });

    it('"both" + disabled update produces no put or patch', () => {
      const resource = createRegistryEntry({
        updateMethod: 'both',
        disabledRoutes: ['update'],
      });
      const spec = buildOpenApiSpec([resource]);

      const itemPath = spec.paths['/products/{id}'];
      expect(itemPath?.put).toBeUndefined();
      expect(itemPath?.patch).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Multiple resources
  // --------------------------------------------------------------------------

  describe('multiple resources', () => {
    it('generates spec with multiple resources using different update methods', () => {
      const patchResource = createRegistryEntry({
        name: 'product',
        prefix: '/products',
        tag: 'Products',
        updateMethod: 'PATCH',
      });
      const putResource = createRegistryEntry({
        name: 'order',
        prefix: '/orders',
        tag: 'Orders',
        updateMethod: 'PUT',
      });
      const bothResource = createRegistryEntry({
        name: 'user',
        prefix: '/users',
        tag: 'Users',
        updateMethod: 'both',
      });

      const spec = buildOpenApiSpec([patchResource, putResource, bothResource]);

      // Product: only PATCH
      expect(spec.paths['/products/{id}']?.patch).toBeDefined();
      expect(spec.paths['/products/{id}']?.put).toBeUndefined();

      // Order: only PUT
      expect(spec.paths['/orders/{id}']?.put).toBeDefined();
      expect(spec.paths['/orders/{id}']?.patch).toBeUndefined();

      // User: both
      expect(spec.paths['/users/{id}']?.put).toBeDefined();
      expect(spec.paths['/users/{id}']?.patch).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Schema generation
  // --------------------------------------------------------------------------

  describe('schema generation', () => {
    it('generates input schema for resource', () => {
      const resource = createRegistryEntry({
        openApiSchemas: {
          createBody: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              price: { type: 'number' },
            },
            required: ['name'],
          },
        },
      });
      const spec = buildOpenApiSpec([resource]);

      expect(spec.components.schemas.productInput).toBeDefined();
      expect((spec.components.schemas.productInput as any).properties?.name).toEqual({
        type: 'string',
      });
    });

    it('generates response schema with _id and timestamps', () => {
      const resource = createRegistryEntry({
        openApiSchemas: {
          createBody: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
          },
        },
      });
      const spec = buildOpenApiSpec([resource]);

      const responseSchema = spec.components.schemas.product as any;
      expect(responseSchema?.properties?._id).toBeDefined();
      expect(responseSchema?.properties?.createdAt).toBeDefined();
      expect(responseSchema?.properties?.updatedAt).toBeDefined();
      expect(responseSchema?.properties?.name).toBeDefined();
    });
  });
});
