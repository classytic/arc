/**
 * Distributed Runtime Validation Tests
 *
 * Verifies that runtime: 'distributed' only enforces stores that the
 * factory actually wires — events always, cache/queryCache only when enabled.
 */

import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/factory/createApp.js';

// Mock durable transport/store (non-memory name)
const mockRedisTransport = { name: 'redis', publish: async () => {}, subscribe: async () => () => {} };
const mockRedisStore = { name: 'redis', get: async () => null, set: async () => {}, delete: async () => {} };

describe('distributed runtime validation', () => {
  it('should throw when events transport is missing', async () => {
    await expect(
      createApp({
        runtime: 'distributed',
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
      }),
    ).rejects.toThrow(/events transport/);
  });

  it('should throw when events transport is memory-backed', async () => {
    await expect(
      createApp({
        runtime: 'distributed',
        stores: { events: { name: 'memory', publish: async () => {}, subscribe: async () => () => {} } as any },
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
      }),
    ).rejects.toThrow(/events transport/);
  });

  it('should NOT require cache store when caching plugin is disabled', async () => {
    // This should succeed — no cache plugin, so no cache store required
    const app = await createApp({
      runtime: 'distributed',
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: { caching: false },
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it('should require cache store when caching plugin is enabled', async () => {
    await expect(
      createApp({
        runtime: 'distributed',
        stores: { events: mockRedisTransport as any },
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
        arcPlugins: { caching: true },
      }),
    ).rejects.toThrow(/cache store/);
  });

  it('should NOT block startup without idempotency store (warns via fastify.log)', async () => {
    // Idempotency is per-resource, not factory-wide — should not block startup.
    // Warning is logged via fastify.log.warn (not console.warn).
    // With logger: false, the warning is suppressed but doesn't crash.
    const app = await createApp({
      runtime: 'distributed',
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it('should NOT require queryCache store when queryCache is disabled', async () => {
    const app = await createApp({
      runtime: 'distributed',
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it('should pass with all required stores for a full distributed setup', async () => {
    const app = await createApp({
      runtime: 'distributed',
      stores: {
        events: mockRedisTransport as any,
        cache: mockRedisStore as any,
      },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: { caching: true },
    });

    expect(app).toBeDefined();
    await app.close();
  });
});

describe('under-pressure preset tolerance', () => {
  it('production preset should use maxEventLoopDelay >= 3000ms', async () => {
    // Import preset directly to verify the value
    const { productionPreset } = await import('../../src/factory/presets.js');
    const upConfig = productionPreset.underPressure as Record<string, unknown>;

    expect(upConfig).toBeDefined();
    expect(upConfig.maxEventLoopDelay).toBeGreaterThanOrEqual(3000);
  });

  it('should allow disabling under-pressure entirely', async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it('edge preset should have under-pressure disabled', async () => {
    const { edgePreset } = await import('../../src/factory/presets.js');
    expect(edgePreset.underPressure).toBe(false);
  });
});
