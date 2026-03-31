/**
 * Auto-Schema Generation from Adapter Tests
 *
 * Validates that when customSchemas is not provided, Arc auto-generates
 * CrudSchemas from the adapter's OpenApiSchemas (createBody, updateBody, params).
 *
 * This eliminates the need for consumers to manually call buildCrudSchemasFromModel()
 * and pass the result as customSchemas — the adapter already has access to the model.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { defineResource } from '../../src/core/defineResource.js';
import { BaseController } from '../../src/core/BaseController.js';
import { createMongooseAdapter } from '../../src/adapters/mongoose.js';
import { allowPublic } from '../../src/permissions/index.js';
import {
  setupTestDatabase,
  teardownTestDatabase,
  clearDatabase,
  createMockModel,
  createMockRepository,
} from '../setup.js';

// ============================================================================
// Setup
// ============================================================================

let mongoUri: string;

beforeAll(async () => {
  mongoUri = await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

// ============================================================================
// Helper: build an app with a resource and return the route schemas
// ============================================================================

async function buildTestApp(
  resourceOptions: {
    schemaOptions?: Record<string, unknown>;
    customSchemas?: Record<string, unknown>;
    schemaGenerator?: (model: unknown, options?: unknown) => Record<string, unknown>;
  } = {},
): Promise<FastifyInstance> {
  const Model = createMockModel('AutoSchema' + Date.now());
  const repo = createMockRepository(Model);

  const adapterOpts: Record<string, unknown> = {
    model: Model,
    repository: repo,
  };
  if (resourceOptions.schemaGenerator) {
    adapterOpts.schemaGenerator = resourceOptions.schemaGenerator;
  }

  const resource = defineResource({
    name: 'item',
    adapter: createMongooseAdapter(adapterOpts as any),
    controller: new BaseController(repo, { resourceName: 'item' }),
    prefix: '/items',
    tag: 'Items',
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    schemaOptions: resourceOptions.schemaOptions as any,
    customSchemas: resourceOptions.customSchemas as any,
  });

  const app = Fastify({ logger: false });
  await app.register(resource.toPlugin());
  await app.ready();

  return app;
}

// ============================================================================
// Tests: Auto-generation from adapter's built-in schema extraction
// ============================================================================

describe('Auto-Schema Generation from Adapter', () => {
  describe('built-in Mongoose schema extraction', () => {
    it('should auto-generate create body schema from model fields', async () => {
      const app = await buildTestApp();

      // POST /items should have a body schema auto-generated from the model
      const response = await app.inject({
        method: 'POST',
        url: '/items',
        payload: { name: 'Test Item', description: 'A test' },
      });

      // Should succeed — the auto-generated schema accepts valid data
      expect(response.statusCode).toBeLessThan(500);

      await app.close();
    });

    it('should auto-generate update body schema from model fields', async () => {
      const app = await buildTestApp();

      // Create first
      const createRes = await app.inject({
        method: 'POST',
        url: '/items',
        payload: { name: 'Update Test' },
      });
      const created = JSON.parse(createRes.body);
      const id = created.data?._id ?? created._id;

      // PATCH should work with auto-generated schema
      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/items/${id}`,
        payload: { name: 'Updated Name' },
      });

      expect(updateRes.statusCode).toBeLessThan(500);

      await app.close();
    });

    it('should auto-generate params schema for get/update/delete routes', async () => {
      const app = await buildTestApp();

      // GET with a valid ID should not fail schema validation
      const getRes = await app.inject({
        method: 'GET',
        url: '/items/507f1f77bcf86cd799439011',
      });

      // Should not be a 400 validation error from missing params schema
      expect(getRes.statusCode).not.toBe(400);

      await app.close();
    });
  });

  // ============================================================================
  // Tests: External schemaGenerator (MongoKit-style)
  // ============================================================================

  describe('external schemaGenerator (MongoKit-style)', () => {
    it('should auto-generate CrudSchemas from schemaGenerator return value', async () => {
      const mockSchemas = {
        createBody: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'published'] },
          },
          required: ['title'],
        },
        updateBody: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'published'] },
          },
        },
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        listQuery: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
          },
          additionalProperties: true,
        },
      };

      const app = await buildTestApp({
        schemaGenerator: () => mockSchemas,
      });

      // POST with invalid body should be rejected (schema validation)
      const invalidRes = await app.inject({
        method: 'POST',
        url: '/items',
        payload: { status: 'invalid_enum_value' }, // missing required 'title'
      });

      // Should be rejected — either 400 (validation) or the create proceeds
      // but the key is that the schema was applied
      // The auto-generated body schema should require 'title'
      expect(invalidRes.statusCode).toBe(400);

      // POST with valid body should succeed
      const validRes = await app.inject({
        method: 'POST',
        url: '/items',
        payload: { title: 'My Article', status: 'draft' },
      });
      expect(validRes.statusCode).toBeLessThan(500);

      await app.close();
    });

    it('should pass schemaOptions to schemaGenerator', async () => {
      let capturedOptions: unknown = null;

      const app = await buildTestApp({
        schemaOptions: {
          fieldRules: {
            deletedAt: { systemManaged: true },
            slug: { immutable: true },
          },
        },
        schemaGenerator: (_model: unknown, options?: unknown) => {
          capturedOptions = options;
          return {
            createBody: { type: 'object', properties: { name: { type: 'string' } } },
            updateBody: { type: 'object', properties: { name: { type: 'string' } } },
          };
        },
      });

      // The schemaGenerator should have received the schemaOptions
      expect(capturedOptions).toMatchObject({
        fieldRules: {
          deletedAt: { systemManaged: true },
          slug: { immutable: true },
        },
      });

      await app.close();
    });
  });

  // ============================================================================
  // Tests: customSchemas override
  // ============================================================================

  describe('customSchemas override', () => {
    it('should use customSchemas when provided instead of auto-generating', async () => {
      const app = await buildTestApp({
        customSchemas: {
          create: {
            body: {
              type: 'object',
              properties: {
                customField: { type: 'string' },
              },
              required: ['customField'],
              additionalProperties: false,
            },
          },
        },
      });

      // Should reject because customField is required and additionalProperties is false
      const missingCustomRes = await app.inject({
        method: 'POST',
        url: '/items',
        payload: { name: 'Test' }, // has 'name' but not 'customField'
      });

      expect(missingCustomRes.statusCode).toBe(400);

      // Should accept with the custom field
      const validRes = await app.inject({
        method: 'POST',
        url: '/items',
        payload: { customField: 'value' },
      });

      expect(validRes.statusCode).toBeLessThan(500);

      await app.close();
    });
  });

  // ============================================================================
  // Tests: graceful fallback
  // ============================================================================

  describe('graceful fallback', () => {
    it('should work with no adapter (no auto-generation, no customSchemas)', async () => {
      // A resource with no adapter and no schemas should still register routes
      // (using default schemas only)
      const Model = createMockModel('FallbackItem' + Date.now());
      const repo = createMockRepository(Model);

      const resource = defineResource({
        name: 'fallback',
        adapter: createMongooseAdapter({ model: Model, repository: repo }),
        controller: new BaseController(repo, { resourceName: 'fallback' }),
        prefix: '/fallbacks',
        tag: 'Fallbacks',
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
      });

      const app = Fastify({ logger: false });
      await app.register(resource.toPlugin());
      await app.ready();

      // Should work — routes are registered with default schemas
      const listRes = await app.inject({ method: 'GET', url: '/fallbacks' });
      expect(listRes.statusCode).toBe(200);

      const createRes = await app.inject({
        method: 'POST',
        url: '/fallbacks',
        payload: { name: 'Fallback Item' },
      });
      expect(createRes.statusCode).toBeLessThan(500);

      await app.close();
    });
  });
});
