/**
 * Resource registration for createApp.
 *
 * Handles: resourcePrefix, skipGlobalPrefix, bootstrap, afterResources.
 */

import type { FastifyInstance } from "fastify";
import type { FastifyPlugin } from "./shared.js";
import type { CreateAppOptions } from "./types.js";

/** Register a single resource with descriptive error on failure. */
async function registerOne(
  parent: FastifyInstance,
  resource: import("./loadResources.js").ResourceLike,
): Promise<void> {
  const name = resource.name ?? "unknown";
  try {
    await parent.register(resource.toPlugin() as FastifyPlugin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parent.log.error(`Failed to register resource "${name}": ${msg}`);
    throw new Error(
      `Resource "${name}" failed to register: ${msg}. ` +
        "Check the resource definition, adapter, and permissions.",
    );
  }
}

/**
 * Execute the full resource lifecycle:
 * 1. plugins()        — infra (DB, docs, webhooks)
 * 2. bootstrap[]      — domain init (singletons, event handlers)
 * 3. resources[]      — auto-discovered routes (split by prefix)
 * 4. afterResources() — post-registration wiring
 * 5. onReady/onClose  — lifecycle hooks
 */
export async function registerResources(
  fastify: FastifyInstance,
  config: CreateAppOptions,
): Promise<void> {
  // ── 1. Custom plugins (infra) ──
  if (config.plugins) {
    await config.plugins(fastify);
    fastify.log.debug("Custom plugins registered");
  }

  // ── 2. Bootstrap (domain init) ──
  if (config.bootstrap?.length) {
    for (const init of config.bootstrap) {
      await init(fastify);
    }
    fastify.log.debug(`${config.bootstrap.length} bootstrap function(s) executed`);
  }

  // ── 3. Resources (split by prefix) ──
  if (config.resources?.length) {
    // Detect duplicate resource names early — a common mistake with loadResources + manual array
    const seen = new Set<string>();
    for (const resource of config.resources) {
      if (resource.name) {
        if (seen.has(resource.name)) {
          fastify.log.warn(
            `Duplicate resource name "${resource.name}" detected. ` +
              "This will cause route conflicts. Check your resources array and loadResources() output.",
          );
        }
        seen.add(resource.name);
      }
    }

    const prefixed: typeof config.resources = [];
    const root: typeof config.resources = [];

    for (const resource of config.resources) {
      if (resource.skipGlobalPrefix) {
        root.push(resource);
      } else {
        prefixed.push(resource);
      }
    }

    // Root resources (skipGlobalPrefix: true) register directly
    for (const resource of root) {
      await registerOne(fastify, resource);
    }

    // Prefixed resources register under resourcePrefix (or root if no prefix)
    if (prefixed.length) {
      if (config.resourcePrefix) {
        await fastify.register(
          async (scoped) => {
            for (const resource of prefixed) {
              await registerOne(scoped, resource);
            }
          },
          { prefix: config.resourcePrefix },
        );
      } else {
        for (const resource of prefixed) {
          await registerOne(fastify, resource);
        }
      }
    }

    const names = config.resources.map((r) => r.name ?? "?").join(", ");
    const prefix = config.resourcePrefix ? ` (prefix: ${config.resourcePrefix})` : "";
    fastify.log.info(`${config.resources.length} resource(s) registered${prefix}: ${names}`);
  }

  // ── 4. After resources ──
  if (config.afterResources) {
    await config.afterResources(fastify);
    fastify.log.debug("afterResources hook executed");
  }

  // ── 5. Lifecycle hooks ──
  if (config.onReady) {
    const onReady = config.onReady;
    fastify.addHook("onReady", async () => {
      await onReady(fastify);
    });
  }
  if (config.onClose) {
    const onClose = config.onClose;
    fastify.addHook("onClose", async () => {
      await onClose(fastify);
    });
  }
}
