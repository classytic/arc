/**
 * Route registration — duplicate detection wrapper.
 */

import type { FastifyWithDecorators } from "../../types/index.js";

/**
 * Register a route with friendly handling of `FST_ERR_DUPLICATED_ROUTE`.
 *
 * Boot-time `validateRouteCrudCollisions()` catches custom-route → auto-CRUD
 * overlaps before Fastify ever runs, but a few cases still slip through to
 * Fastify itself: two presets contributing the same `routes` entry, hosts
 * mounting two resources at the same prefix, custom routes that share a
 * URL with another plugin. Fastify's default message ("Method 'GET'
 * already declared for route '/'") gives no hint at the resource-shaped
 * fix — `disabledRoutes: ['list']` — so wrap it with one.
 */
export function tryRegisterRoute(
  fastify: FastifyWithDecorators,
  opts: Parameters<FastifyWithDecorators["route"]>[0],
  context: { resourceName: string; op?: string },
): void {
  try {
    fastify.route(opts);
  } catch (err) {
    const fastifyErr = err as { code?: string; message?: string };
    if (fastifyErr?.code !== "FST_ERR_DUPLICATED_ROUTE") throw err;

    const method = (opts as { method: string }).method;
    const url = (opts as { url: string }).url;
    const opHint = context.op ? ` (op: ${context.op})` : "";
    const fixHint =
      context.op && ["list", "get", "create", "update", "delete"].includes(context.op)
        ? ` Suppress the auto-CRUD route with \`disabledRoutes: ['${context.op}']\`.`
        : " If a custom route in `routes:` collides with auto-CRUD, add" +
          " `disabledRoutes: ['list' | 'get' | 'create' | 'update' | 'delete']`" +
          " to `defineResource()` to suppress the matching auto-CRUD route.";

    const enhanced = new Error(
      `[arc] Duplicate route ${method} ${url} on resource "${context.resourceName}"${opHint}.${fixHint}` +
        ` Original: ${fastifyErr.message ?? "FST_ERR_DUPLICATED_ROUTE"}`,
    );
    (enhanced as { code?: string }).code = "FST_ERR_DUPLICATED_ROUTE";
    (enhanced as { cause?: unknown }).cause = err;
    throw enhanced;
  }
}
