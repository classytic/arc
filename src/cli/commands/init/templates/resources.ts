/**
 * Resource-registry templates: `src/resources/index.ts` (registers every
 * resource at `/api/*`) and `src/shared/index.ts` (barrel re-exporting
 * the adapter factory, permissions, and presets).
 */

import type { ProjectConfig } from "../types.js";

export function resourcesIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : "";
  const appType = ts ? ": FastifyInstance" : "";

  const authImports =
    config.auth === "jwt"
      ? `
// Auth resources (register, login, /users/me)
import { authResource, userProfileResource } from './auth/auth.resource.js';
`
      : `
// Auth is handled by Better Auth — routes at /api/auth/*
// No manual auth resource needed.
`;

  const authResources =
    config.auth === "jwt"
      ? `  authResource,
  userProfileResource,
  `
      : `  `;

  return `/**
 * Resources Registry
 *
 * Central registry for all API resources.
 * All resources are mounted under /api prefix via Fastify scoping.
 */

${typeImport}${authImports}
// App resources
import exampleResource from './example/example.resource.js';

// Add more resources here:
// import productResource from './product/product.resource.js';

/**
 * All registered resources
 */
export const resources = [
${authResources}exampleResource,
]${ts ? " as const" : ""};

/**
 * Register all resources with the app under a common prefix.
 * Fastify scoping ensures all routes are mounted at /api/*.
 * The apiPrefix option in openApiPlugin keeps OpenAPI docs in sync.
 */
export async function registerResources(app${appType}, prefix = '/api')${ts ? ": Promise<void>" : ""} {
  await app.register(async (scope) => {
    for (const resource of resources) {
      await scope.register(resource.toPlugin());
    }
  }, { prefix });
}
`;
}

export function sharedIndexTemplate(_config: ProjectConfig): string {
  return `/**
 * Shared Utilities
 *
 * Central exports for resource definitions.
 * Import from here for clean, consistent code.
 */

// Adapter factory
export { createAdapter } from './adapter.js';

// Core Arc exports
export { defineResource } from '@classytic/arc';
export { createMongooseAdapter } from '@classytic/mongokit/adapter';

// Permission helpers (core + application-level)
export * from './permissions.js';

// Presets
export * from './presets/index.js';
`;
}
