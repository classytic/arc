/**
 * Arc Full Example App
 *
 * Demonstrates the cleanest createApp setup:
 * - loadResources(import.meta.url) for auto-discovery (works in dev + prod)
 * - resourcePrefix for API versioning
 * - Per-resource audit opt-in (no growing exclude lists)
 * - JWT auth, presets, permissions, hooks, events
 */

import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { auditPlugin } from "../../src/audit/index.js";
import { createApp, loadResources } from "../../src/factory/index.js";

export interface AppOptions {
  mongoUri: string;
  jwtSecret: string;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  await mongoose.connect(opts.mongoUri);

  const app = await createApp({
    auth: {
      type: "jwt",
      jwt: { secret: opts.jwtSecret },
    },

    resourcePrefix: "/api/v1",

    // Auto-discover all *.resource.ts files in ./resources/
    // Resolves relative to THIS file — works in src/ (dev) and dist/ (prod)
    resources: await loadResources(import.meta.url),

    plugins: async (fastify) => {
      // Per-resource audit opt-in: only resources with `audit: true`
      // in their defineResource() config are audited.
      // No growing exclude list, no centralized allowlist to maintain.
      await fastify.register(auditPlugin, {
        autoAudit: { perResource: true },
      });
    },
  });

  return app;
}
