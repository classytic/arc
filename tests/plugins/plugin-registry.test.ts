/**
 * Plugin Registry Tests
 *
 * Tests that plugins are tracked in the `fastify.arc.plugins` Map after registration.
 * Verifies plugin metadata (name, registeredAt) and that createApp registers core plugins.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../../src/factory/createApp.js';

describe('Plugin Registry', () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  afterAll(async () => {
    await app?.close();
  });

  it('tracks registered plugins as a Map', async () => {
    app = await createApp({
      preset: 'testing',
      auth: false,
    });
    await app.ready();

    expect(app.arc.plugins).toBeInstanceOf(Map);
  });

  it('registers arc-core plugin', async () => {
    // app is already created in the previous test
    expect(app.arc.plugins.has('arc-core')).toBe(true);

    const corePlugin = app.arc.plugins.get('arc-core');
    expect(corePlugin?.name).toBe('arc-core');
    expect(corePlugin?.registeredAt).toBeDefined();
    expect(typeof corePlugin?.registeredAt).toBe('string');
  });

  it('registers arc-health plugin by default', async () => {
    expect(app.arc.plugins.has('arc-health')).toBe(true);

    const healthPlugin = app.arc.plugins.get('arc-health');
    expect(healthPlugin?.name).toBe('arc-health');
    expect(healthPlugin?.registeredAt).toBeDefined();
  });

  it('registers arc-request-id plugin by default', async () => {
    expect(app.arc.plugins.has('arc-request-id')).toBe(true);

    const requestIdPlugin = app.arc.plugins.get('arc-request-id');
    expect(requestIdPlugin?.name).toBe('arc-request-id');
    expect(requestIdPlugin?.registeredAt).toBeDefined();
  });

  it('registers arc-graceful-shutdown plugin by default', async () => {
    expect(app.arc.plugins.has('arc-graceful-shutdown')).toBe(true);

    const shutdownPlugin = app.arc.plugins.get('arc-graceful-shutdown');
    expect(shutdownPlugin?.name).toBe('arc-graceful-shutdown');
    expect(shutdownPlugin?.registeredAt).toBeDefined();
  });

  it('plugin metadata registeredAt is a valid ISO timestamp', async () => {
    const corePlugin = app.arc.plugins.get('arc-core');
    const timestamp = corePlugin?.registeredAt;
    expect(timestamp).toBeDefined();

    // Should be a valid ISO date string
    const parsed = new Date(timestamp!);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it('has at least 4 plugins registered (core, health, request-id, graceful-shutdown)', async () => {
    expect(app.arc.plugins.size).toBeGreaterThanOrEqual(4);
  });
});

describe('Plugin Registry — arcCorePlugin standalone', () => {
  it('initializes an empty plugins Map via arcCorePlugin', async () => {
    const Fastify = (await import('fastify')).default;
    const { arcCorePlugin } = await import('../../src/core/arcCorePlugin.js');

    const fastify = Fastify({ logger: false });
    await fastify.register(arcCorePlugin, { emitEvents: false });
    await fastify.ready();

    expect(fastify.arc.plugins).toBeInstanceOf(Map);
    // arcCorePlugin itself does not call trackPlugin — that's done by createApp
    // So when registered standalone, the map starts empty
    expect(fastify.arc.plugins.size).toBe(0);

    await fastify.close();
  });

  it('allows manual plugin tracking', async () => {
    const Fastify = (await import('fastify')).default;
    const { arcCorePlugin } = await import('../../src/core/arcCorePlugin.js');

    const fastify = Fastify({ logger: false });
    await fastify.register(arcCorePlugin, { emitEvents: false });
    await fastify.ready();

    // Manually track a plugin (as createApp does)
    fastify.arc.plugins.set('my-custom-plugin', {
      name: 'my-custom-plugin',
      version: '1.0.0',
      options: { debug: true },
      registeredAt: new Date().toISOString(),
    });

    expect(fastify.arc.plugins.has('my-custom-plugin')).toBe(true);
    const meta = fastify.arc.plugins.get('my-custom-plugin');
    expect(meta?.name).toBe('my-custom-plugin');
    expect(meta?.version).toBe('1.0.0');
    expect(meta?.options).toEqual({ debug: true });
    expect(meta?.registeredAt).toBeDefined();

    await fastify.close();
  });
});
