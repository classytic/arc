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

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { MUTATION_OPERATIONS } from "../constants.js";
import type { RequestStore } from "../context/requestContext.js";
import { requestContext } from "../context/requestContext.js";
import type { ExternalOpenApiPaths } from "../docs/externalPaths.js";
import { HookSystem } from "../hooks/HookSystem.js";
import { ResourceRegistry } from "../registry/ResourceRegistry.js";
import type { RequestScope } from "../scope/types.js";
import { getOrgId } from "../scope/types.js";
import { hasEvents } from "../utils/typeGuards.js";

export interface ArcCorePluginOptions {
  /** Enable event emission for CRUD operations (requires eventPlugin) */
  emitEvents?: boolean;
  /** Hook system instance (for testing/custom setup) */
  hookSystem?: HookSystem;
  /** Resource registry instance (for testing/custom setup) */
  registry?: ResourceRegistry;
}

export interface PluginMeta {
  name: string;
  version?: string;
  options?: Record<string, unknown>;
  registeredAt: string;
}

export interface ArcCore {
  /** Instance-scoped hook system */
  hooks: HookSystem;
  /** Instance-scoped resource registry */
  registry: ResourceRegistry;
  /** Whether event emission is enabled */
  emitEvents: boolean;
  /** External OpenAPI paths contributed by auth adapters or third-party integrations */
  externalOpenApiPaths: ExternalOpenApiPaths[];
  /** Registered plugins for introspection */
  plugins: Map<string, PluginMeta>;
}

declare module "fastify" {
  interface FastifyInstance {
    arc: ArcCore;
  }
}

const arcCorePlugin: FastifyPluginAsync<ArcCorePluginOptions> = async (
  fastify: FastifyInstance,
  opts: ArcCorePluginOptions = {},
) => {
  const { emitEvents = true, hookSystem, registry } = opts;

  // Always use instance-scoped systems — no global singletons
  const actualHookSystem = hookSystem ?? new HookSystem();
  const actualRegistry = registry ?? new ResourceRegistry();

  // Decorate with instance-scoped Arc core
  fastify.decorate("arc", {
    hooks: actualHookSystem,
    registry: actualRegistry,
    emitEvents,
    externalOpenApiPaths: [],
    plugins: new Map<string, PluginMeta>(),
  });

  // Request context via AsyncLocalStorage — zero-cost per request.
  // storage.run(store, done) wraps the ENTIRE remaining request lifecycle
  // so any code in the call stack can access user/org/requestId.
  fastify.addHook("onRequest", (request, _reply, done) => {
    const store: RequestStore = {
      requestId: request.id,
      startTime: performance.now(),
    };

    requestContext.storage.run(store, done);
  });

  // Populate user/org after auth middleware runs (user isn't set during onRequest)
  fastify.addHook("preHandler", (request, _reply, done) => {
    const store = requestContext.get();
    if (store) {
      const req = request as unknown as Record<string, unknown>;
      store.user = (req.user as RequestStore["user"]) ?? null;
      store.organizationId =
        request.scope?.kind === "member"
          ? request.scope.organizationId
          : request.scope?.kind === "elevated"
            ? request.scope.organizationId
            : undefined;
    }
    done();
  });

  // Wire events into hooks if event plugin is available and events enabled
  if (emitEvents) {
    // Register after hooks that emit events
    const eventOperations = MUTATION_OPERATIONS;

    for (const operation of eventOperations) {
      actualHookSystem.after("*", operation, async (ctx) => {
        // Check if events plugin is registered using type guard
        if (!hasEvents(fastify)) return;

        const store = requestContext.get();
        const eventType = `${ctx.resource}.${operation}d`; // e.g., 'product.created'
        const userId = ctx.user?.id ?? ctx.user?._id;
        const organizationId = ctx.context?._scope
          ? getOrgId(ctx.context._scope as RequestScope)
          : undefined;
        const payload = {
          resource: ctx.resource,
          operation: ctx.operation,
          data: ctx.result,
          userId,
          organizationId,
          timestamp: new Date().toISOString(),
        };

        try {
          await fastify.events.publish(eventType, payload, {
            correlationId: store?.requestId,
            resource: ctx.resource,
            resourceId: extractId(ctx.result),
            userId: userId ? String(userId) : undefined,
            organizationId,
          });
        } catch (error) {
          // Log but don't fail the request
          fastify.log?.warn?.({ eventType, error }, "Failed to emit event");
        }
      });
    }
  }

  // Emit arc.ready lifecycle event when all resources are registered
  fastify.addHook("onReady", async () => {
    if (!hasEvents(fastify)) return;
    try {
      await fastify.events.publish("arc.ready", {
        resources: actualRegistry.getAll().length,
        hooks: actualHookSystem.getAll().length,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Lifecycle events are best-effort
    }
  });

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    actualHookSystem.clear();
    actualRegistry._clear();
  });

  fastify.log?.debug?.("Arc core plugin enabled (instance-scoped hooks & registry)");
};

/** Extract document ID from a result (handles Mongoose docs and plain objects) */
function extractId(doc: unknown): string | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as Record<string, unknown>;
  const rawId = d._id ?? d.id;
  return rawId ? String(rawId) : undefined;
}

export default fp(arcCorePlugin, {
  name: "arc-core",
  fastify: "5.x",
});

export { arcCorePlugin };
