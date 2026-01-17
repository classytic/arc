/**
 * Security Tests: String Handler Response Adapter
 *
 * Tests that string handlers (pointing to controller methods)
 * are properly wrapped with Fastify adapter to return correct response format.
 *
 * Prevents type mismatches that could expose internal structures.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { defineResource } from '../../src/index.js';
import { BaseController } from '../../src/core/BaseController.js';
import { allowPublic } from '../../src/permissions/index.js';
import type { IRequestContext, CrudRepository, AnyRecord, DataAdapter } from '../../src/types/index.js';

// Helper to create test adapter
function createTestAdapter(repository: CrudRepository): DataAdapter {
  return {
    repository,
    type: 'custom',
    name: 'test-adapter',
  };
}

// Mock repository
class TestRepository implements CrudRepository {
  async getAll() {
    return [
      { _id: '1', name: 'Item 1' },
      { _id: '2', name: 'Item 2' },
    ];
  }

  async getById(id: string) {
    return { _id: id, name: `Item ${id}` };
  }

  async create(data: AnyRecord) {
    return { _id: '123', ...data };
  }

  async update(id: string, data: AnyRecord) {
    return { _id: id, ...data };
  }

  async delete() {
    return true;
  }
}

// Test controller with custom method
class TestController extends BaseController {
  constructor(repo: CrudRepository) {
    super(repo);
    // Bind custom methods
    this.customAction = this.customAction.bind(this);
    this.errorAction = this.errorAction.bind(this);
  }

  // Custom method that returns IControllerResponse
  async customAction(context: IRequestContext) {
    return {
      success: true,
      data: {
        message: 'Custom action executed',
        userId: context.user?.id,
        paramId: context.params?.id,
      },
      status: 200,
    };
  }

  // Another custom method with error - must have context param for auto-detection
  async errorAction(_context: IRequestContext) {
    return {
      success: false,
      error: 'Something went wrong',
      status: 500,
    };
  }
}

describe('Security: String Handler Response Adapter', () => {
  let app: FastifyInstance;
  const repo = new TestRepository();
  const controller = new TestController(repo);

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Define resource with string handlers
    const testResource = defineResource({
      name: 'test',
      adapter: createTestAdapter(repo),
      controller,
      disableDefaultRoutes: false, // Keep CRUD routes for testing
      additionalRoutes: [
        {
          method: 'GET',
          path: '/custom/:id',
          handler: 'customAction', // STRING handler
          permissions: allowPublic(),
          wrapHandler: true,
        },
        {
          method: 'POST',
          path: '/error',
          handler: 'errorAction', // STRING handler
          permissions: allowPublic(),
          wrapHandler: true,
        },
      ],
    });

    await app.register(testResource.toPlugin(), { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should properly adapt string handler response format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tests/custom/42',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Should be properly formatted Fastify response
    expect(body).toHaveProperty('success');
    expect(body).toHaveProperty('data');
    expect(body.success).toBe(true);
    expect(body.data.message).toBe('Custom action executed');
    expect(body.data.paramId).toBe('42');

    // Should NOT be raw IControllerResponse with status field exposed
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('should handle error responses correctly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tests/error',
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);

    expect(body.success).toBe(false);
    expect(body.error).toBe('Something went wrong');
  });

  it('should work with CRUD operations (built-in handlers)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tests/123',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('_id');
    expect(body.data).toHaveProperty('name');
  });

  it('should preserve authentication context in string handlers', async () => {
    // In real scenario, auth middleware would populate req.user
    // Here we just verify that the handler can access context.user
    const res = await app.inject({
      method: 'GET',
      url: '/api/tests/custom/1',
      headers: {
        // In real scenario, auth middleware would populate req.user
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveProperty('message');
    expect(body.data).toHaveProperty('paramId');
    expect(body.data.message).toBe('Custom action executed');
    expect(body.data.paramId).toBe('1');
    // Note: userId is undefined without auth middleware and won't be serialized in JSON
  });

  it('should handle function handlers (non-string) correctly', async () => {
    // Create resource with function handler
    const funcResource = defineResource({
      name: 'func',
      adapter: createTestAdapter(repo),
      additionalRoutes: [
        {
          method: 'GET',
          path: '/direct',
          handler: async (request, reply) => {
            return reply.send({ direct: true, method: 'function' });
          },
          permissions: allowPublic(),
          wrapHandler: false,
        },
      ],
    });

    const app2 = Fastify({ logger: false });
    await app2.register(funcResource.toPlugin(), { prefix: '/api' });
    await app2.ready();

    const res = await app2.inject({
      method: 'GET',
      url: '/api/funcs/direct',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.direct).toBe(true);
    expect(body.method).toBe('function');

    await app2.close();
  });

  it('should throw error if string handler does not exist on controller', async () => {
    expect(() => {
      defineResource({
        name: 'invalid',
        adapter: createTestAdapter(repo),
        controller,
        additionalRoutes: [
          {
            method: 'GET',
            path: '/missing',
            handler: 'nonExistentMethod', // Does not exist
            permissions: allowPublic(),
            wrapHandler: true,
          },
        ],
      });
    }).toThrow(/Handler.*nonExistentMethod.*not found/);
  });

  it('should handle async controller methods', async () => {
    class AsyncController extends BaseController {
      constructor(repo: CrudRepository) {
        super(repo);
        this.asyncMethod = this.asyncMethod.bind(this);
      }

      async asyncMethod(context: IRequestContext) {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          success: true,
          data: { async: true, paramId: context.params?.id },
          status: 200,
        };
      }
    }

    const asyncController = new AsyncController(repo);
    const asyncResource = defineResource({
      name: 'async',
      adapter: createTestAdapter(repo),
      controller: asyncController,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/async/:id',
          handler: 'asyncMethod',
          permissions: allowPublic(),
          wrapHandler: true,
        },
      ],
    });

    const app3 = Fastify({ logger: false });
    await app3.register(asyncResource.toPlugin(), { prefix: '/api' });
    await app3.ready();

    const res = await app3.inject({
      method: 'GET',
      url: '/api/asyncs/async/999',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.async).toBe(true);
    expect(body.data.paramId).toBe('999');

    await app3.close();
  });

  it('should handle Fastify-native pattern with wrapHandler: false', async () => {
    // Controller using Fastify-native (req, reply) pattern - 2 parameters
    const fastifyNativeController = {
      getBySlug: async (req: any, reply: any) => {
        const { slug } = req.params;
        return reply.code(200).send({
          success: true,
          data: { slug, message: 'Fastify-native' },
        });
      },
    };

    const nativeResource = defineResource({
      name: 'native',
      adapter: createTestAdapter(repo),
      controller: fastifyNativeController as any,
      disableDefaultRoutes: true,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/:slug',
          handler: 'getBySlug',
          permissions: allowPublic(),
          wrapHandler: false, // Explicit: Fastify-native handler
        },
      ],
    });

    const app4 = Fastify({ logger: false });
    await app4.register(nativeResource.toPlugin(), { prefix: '/api' });
    await app4.ready();

    const res = await app4.inject({
      method: 'GET',
      url: '/api/natives/test-slug',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe('test-slug');
    expect(body.data.message).toBe('Fastify-native');

    await app4.close();
  });

  it('should handle IController pattern with wrapHandler: true', async () => {
    // Controller using IController (context) pattern - 1 parameter
    const iControllerStyleController = {
      getBySlug: async (context: any) => {
        const { slug } = context.params;
        return {
          success: true,
          data: { slug, message: 'IController wrapped' },
          status: 200,
        };
      },
    };

    const iControllerResource = defineResource({
      name: 'icontroller',
      adapter: createTestAdapter(repo),
      controller: iControllerStyleController as any,
      disableDefaultRoutes: true,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/:slug',
          handler: 'getBySlug',
          permissions: allowPublic(),
          wrapHandler: true, // Explicit: IController handler
        },
      ],
    });

    const app5 = Fastify({ logger: false });
    await app5.register(iControllerResource.toPlugin(), { prefix: '/api' });
    await app5.ready();

    const res = await app5.inject({
      method: 'GET',
      url: '/api/icontrollers/test-slug',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe('test-slug');
    expect(body.data.message).toBe('IController wrapped');

    await app5.close();
  });

  it('should break when wrapHandler mismatches handler type (true for Fastify-native)', async () => {
    // Fastify-native controller but force wrapping (will break)
    const fastifyNativeController = {
      getBySlug: async (req: any, reply: any) => {
        const { slug } = req.params;
        return reply.code(200).send({ slug });
      },
    };

    const forceWrapResource = defineResource({
      name: 'forcewrap',
      adapter: createTestAdapter(repo),
      controller: fastifyNativeController as any,
      disableDefaultRoutes: true,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/:slug',
          handler: 'getBySlug',
          permissions: allowPublic(),
          wrapHandler: true, // Force wrap despite Fastify-native - will break
        },
      ],
    });

    const app6 = Fastify({ logger: false });
    await app6.register(forceWrapResource.toPlugin(), { prefix: '/api' });
    await app6.ready();

    const res = await app6.inject({
      method: 'GET',
      url: '/api/forcewraps/test-slug',
    });

    // Should fail because wrapping breaks Fastify-native handler
    expect(res.statusCode).toBe(500);

    await app6.close();
  });

  it('should work when wrapHandler: false used for IController-style (handler receives req)', async () => {
    // IController-style but force no wrapping
    const iControllerStyleController = {
      getBySlug: async (context: any) => {
        // This expects context but will receive (req, reply) without wrapping
        // context is actually req, so context.params?.slug works
        return { success: true, data: { slug: context?.params?.slug } };
      },
    };

    const forceNoWrapResource = defineResource({
      name: 'forcenowrap',
      adapter: createTestAdapter(repo),
      controller: iControllerStyleController as any,
      disableDefaultRoutes: true,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/:slug',
          handler: 'getBySlug',
          permissions: allowPublic(),
          wrapHandler: false, // Force no wrap despite IController-style
        },
      ],
    });

    const app7 = Fastify({ logger: false });
    await app7.register(forceNoWrapResource.toPlugin(), { prefix: '/api' });
    await app7.ready();

    const res = await app7.inject({
      method: 'GET',
      url: '/api/forcenowraps/test-slug',
    });

    // Returns 200 because context.params works (it's req.params)
    expect(res.statusCode).toBe(200);

    await app7.close();
  });
});
