/**
 * Arc Core Plugin
 *
 * Sets up instance-scoped Arc systems:
 * - HookSystem: Lifecycle hooks per app instance
 * - ResourceRegistry: Resource tracking per app instance
 * - Event integration: Wires CRUD operations to fastify.events
 *
 * This solves the global singleton leak problem where multiple
 * app instances (e.g., in tests) would share state.
 *
 * @example
 * import { arcCorePlugin } from '@classytic/arc';
 *
 * const app = Fastify();
 * await app.register(arcCorePlugin);
 *
 * // Now use instance-scoped hooks
 * app.arc.hooks.before('product', 'create', async (ctx) => {
 *   ctx.data.slug = slugify(ctx.data.name);
 * });
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { HookSystem, hookSystem as globalHookSystem } from '../hooks/HookSystem.js';
import { ResourceRegistry, resourceRegistry as globalRegistry } from '../registry/ResourceRegistry.js';

/**
 * Interface for fastify.events (from eventPlugin)
 * Defined here to avoid circular dependency with events module
 */
interface EventsInterface {
  publish: <T>(type: string, payload: T) => Promise<void>;
}

/**
 * Type guard to check if fastify has events plugin registered
 */
function hasEvents(instance: FastifyInstance): instance is FastifyInstance & { events: EventsInterface } {
  return 'events' in instance && instance.events != null && typeof (instance.events as EventsInterface).publish === 'function';
}

export interface ArcCorePluginOptions {
  /** Enable event emission for CRUD operations (requires eventPlugin) */
  emitEvents?: boolean;
  /** Hook system instance (for testing/custom setup) */
  hookSystem?: HookSystem;
  /** Resource registry instance (for testing/custom setup) */
  registry?: ResourceRegistry;
  /**
   * Use global singletons for backward compatibility with presets
   * When false (default), creates new isolated instances for better test isolation
   * When true, uses global hookSystem/registry (for preset compatibility)
   */
  useGlobalSingletons?: boolean;
}

export interface ArcCore {
  /** Instance-scoped hook system */
  hooks: HookSystem;
  /** Instance-scoped resource registry */
  registry: ResourceRegistry;
  /** Whether event emission is enabled */
  emitEvents: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    arc: ArcCore;
  }
}

const arcCorePlugin: FastifyPluginAsync<ArcCorePluginOptions> = async (
  fastify: FastifyInstance,
  opts: ArcCorePluginOptions = {}
) => {
  const {
    emitEvents = true,
    hookSystem,
    registry,
    useGlobalSingletons = false,
  } = opts;

  // Determine which instances to use
  // When useGlobalSingletons is true, use global singletons (for preset compatibility)
  // Otherwise, create new isolated instances (better for testing)
  const actualHookSystem = useGlobalSingletons
    ? globalHookSystem
    : (hookSystem ?? new HookSystem());
  const actualRegistry = useGlobalSingletons
    ? globalRegistry
    : (registry ?? new ResourceRegistry());

  // Decorate with instance-scoped Arc core
  fastify.decorate('arc', {
    hooks: actualHookSystem,
    registry: actualRegistry,
    emitEvents,
  });

  // Wire events into hooks if event plugin is available and events enabled
  if (emitEvents) {
    // Register after hooks that emit events
    const eventOperations = ['create', 'update', 'delete'] as const;

    for (const operation of eventOperations) {
      actualHookSystem.after('*', operation, async (ctx) => {
        // Check if events plugin is registered using type guard
        if (!hasEvents(fastify)) return;

        const eventType = `${ctx.resource}.${operation}d`; // e.g., 'product.created'
        const payload = {
          resource: ctx.resource,
          operation: ctx.operation,
          data: ctx.result,
          userId: ctx.user?.id ?? ctx.user?._id,
          organizationId: ctx.context?.organizationId,
          timestamp: new Date().toISOString(),
        };

        try {
          await fastify.events.publish(eventType, payload);
        } catch (error) {
          // Log but don't fail the request
          fastify.log?.warn?.(
            { eventType, error },
            'Failed to emit event'
          );
        }
      });
    }
  }

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    actualHookSystem.clear();
    actualRegistry._clear();
  });

  fastify.log?.info?.('✅ Arc core plugin enabled (instance-scoped hooks & registry)');
};

export default fp(arcCorePlugin, {
  name: 'arc-core',
  fastify: '5.x',
});

export { arcCorePlugin };
