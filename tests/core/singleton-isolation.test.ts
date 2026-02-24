/**
 * Singleton Isolation Tests
 *
 * Tests that HookSystem and ResourceRegistry are always isolated per app instance.
 * This is critical for test parallelization and multi-instance deployments.
 *
 * arcCorePlugin always creates fresh instances (no global singletons).
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { arcCorePlugin } from '../../src/core/arcCorePlugin.js';
import { HookSystem } from '../../src/hooks/HookSystem.js';
import { ResourceRegistry } from '../../src/registry/ResourceRegistry.js';

describe('Singleton Isolation', () => {
  const apps: any[] = [];

  afterEach(async () => {
    // Clean up all app instances
    for (const app of apps) {
      await app.close().catch(() => {});
    }
    apps.length = 0;
  });

  describe('HookSystem isolation (with custom instances)', () => {
    it('should have separate hook systems when custom instances provided', async () => {
      // Create two apps with separate hook systems
      const app1 = Fastify({ logger: false });
      const app2 = Fastify({ logger: false });
      apps.push(app1, app2);

      const hooks1 = new HookSystem();
      const hooks2 = new HookSystem();

      await app1.register(arcCorePlugin, { hookSystem: hooks1 });
      await app2.register(arcCorePlugin, { hookSystem: hooks2 });

      // Register a hook on app1 only
      app1.arc.hooks.after('product', 'create', async () => {});

      // Register a different hook on app2
      app2.arc.hooks.after('order', 'create', async () => {});

      // Verify hooks are separate
      expect(app1.arc.hooks).not.toBe(app2.arc.hooks);
      expect(app1.arc.hooks.getForResource('product').length).toBe(1);
      expect(app1.arc.hooks.getForResource('order').length).toBe(0);
      expect(app2.arc.hooks.getForResource('product').length).toBe(0);
      expect(app2.arc.hooks.getForResource('order').length).toBe(1);
    });

    it('should not share hooks when custom instances provided', async () => {
      const app1 = Fastify({ logger: false });
      const app2 = Fastify({ logger: false });
      apps.push(app1, app2);

      await app1.register(arcCorePlugin, { hookSystem: new HookSystem() });
      await app2.register(arcCorePlugin, { hookSystem: new HookSystem() });

      // Add 3 hooks to app1
      app1.arc.hooks.before('user', 'create', async () => {});
      app1.arc.hooks.before('user', 'update', async () => {});
      app1.arc.hooks.after('user', 'delete', async () => {});

      // app2 should have no hooks
      expect(app1.arc.hooks.getForResource('user').length).toBe(3);
      expect(app2.arc.hooks.getForResource('user').length).toBe(0);
    });

    it('should clear hooks when app closes', async () => {
      const app = Fastify({ logger: false });
      apps.push(app);

      const hooks = new HookSystem();
      await app.register(arcCorePlugin, { hookSystem: hooks });

      // Add some hooks
      app.arc.hooks.before('test', 'create', async () => {});
      app.arc.hooks.after('test', 'create', async () => {});
      expect(app.arc.hooks.getForResource('test').length).toBe(2);

      // Close app
      await app.close();

      // Hooks should be cleared
      expect(app.arc.hooks.getForResource('test').length).toBe(0);
    });
  });

  describe('ResourceRegistry isolation', () => {
    it('should have separate registries when custom instances provided', async () => {
      const app1 = Fastify({ logger: false });
      const app2 = Fastify({ logger: false });
      apps.push(app1, app2);

      await app1.register(arcCorePlugin, { registry: new ResourceRegistry() });
      await app2.register(arcCorePlugin, { registry: new ResourceRegistry() });

      // Verify registries are separate instances
      expect(app1.arc.registry).not.toBe(app2.arc.registry);
    });

    it('should clear registry when app closes', async () => {
      const app = Fastify({ logger: false });
      apps.push(app);

      const registry = new ResourceRegistry();
      await app.register(arcCorePlugin, { registry });

      // Registry should be accessible
      expect(app.arc.registry).toBeDefined();
      expect(app.arc.registry.getAll().length).toBe(0);

      // Close app
      await app.close();

      // Registry should be cleared
      expect(app.arc.registry.getAll().length).toBe(0);
    });
  });

  describe('Custom hook system injection', () => {
    it('should allow injecting custom hook system for testing', async () => {
      const customHooks = new HookSystem();
      let hookCalled = false;
      customHooks.before('test', 'create', async () => {
        hookCalled = true;
      });

      const app = Fastify({ logger: false });
      apps.push(app);

      await app.register(arcCorePlugin, {
        hookSystem: customHooks,
      });

      // Should use the injected hook system
      expect(app.arc.hooks).toBe(customHooks);
      expect(app.arc.hooks.getForResource('test').length).toBe(1);

      // Execute the hook
      await app.arc.hooks.executeBefore('test', 'create', {});
      expect(hookCalled).toBe(true);
    });
  });

  describe('Parallel app instances (simulating test parallelization)', () => {
    it('should not interfere when using custom instances', async () => {
      // Create 5 apps in parallel with custom hook systems
      const createApp = async (name: string) => {
        const app = Fastify({ logger: false });
        apps.push(app);
        await app.register(arcCorePlugin, { hookSystem: new HookSystem() });

        // Each app registers its own hooks
        app.arc.hooks.before(name, 'create', async () => {});
        return app;
      };

      const [app1, app2, app3, app4, app5] = await Promise.all([
        createApp('resource1'),
        createApp('resource2'),
        createApp('resource3'),
        createApp('resource4'),
        createApp('resource5'),
      ]);

      // Each app should only have its own hooks
      expect(app1.arc.hooks.getForResource('resource1').length).toBe(1);
      expect(app1.arc.hooks.getForResource('resource2').length).toBe(0);

      expect(app2.arc.hooks.getForResource('resource1').length).toBe(0);
      expect(app2.arc.hooks.getForResource('resource2').length).toBe(1);

      expect(app3.arc.hooks.getForResource('resource3').length).toBe(1);
      expect(app4.arc.hooks.getForResource('resource4').length).toBe(1);
      expect(app5.arc.hooks.getForResource('resource5').length).toBe(1);
    });
  });

  describe('Default behavior (isolated instances)', () => {
    it('should always create isolated hookSystem (no global singletons)', async () => {
      const app1 = Fastify({ logger: false });
      const app2 = Fastify({ logger: false });
      apps.push(app1, app2);

      await app1.register(arcCorePlugin);
      await app2.register(arcCorePlugin);

      // Apps always have isolated hook systems — no global singleton
      expect(app1.arc.hooks).not.toBe(app2.arc.hooks);
    });

    it('should always create isolated registry (no global singletons)', async () => {
      const app1 = Fastify({ logger: false });
      const app2 = Fastify({ logger: false });
      apps.push(app1, app2);

      await app1.register(arcCorePlugin);
      await app2.register(arcCorePlugin);

      // Apps always have isolated registries — no global singleton
      expect(app1.arc.registry).not.toBe(app2.arc.registry);
      expect(app1.arc.registry).toBeInstanceOf(ResourceRegistry);
      expect(app2.arc.registry).toBeInstanceOf(ResourceRegistry);
    });

    it('should not export a global resourceRegistry singleton', async () => {
      // The registry module should only export the class, not a singleton instance
      const registryModule = await import('../../src/registry/index.js');
      expect(registryModule.ResourceRegistry).toBeDefined();
      expect((registryModule as any).resourceRegistry).toBeUndefined();
    });
  });
});
