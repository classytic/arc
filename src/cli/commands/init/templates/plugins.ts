/**
 * Plugins-index template — the scaffold's `src/plugins/index.ts` file.
 *
 * Single-template module on purpose: plugins are the user's main
 * extension point and may grow over time, so keeping the file isolated
 * avoids tangling unrelated edits.
 */

import type { ProjectConfig } from "../types.js";

export function pluginsIndexTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? "import type { FastifyInstance } from 'fastify';\n" : "";
  const configType = ts ? ": { config: AppConfig }" : "";
  const appType = ts ? ": FastifyInstance" : "";

  let content = `/**
 * App Plugins Registry
 *
 * Register your app-specific plugins here.
 * Dependencies are passed explicitly (no shims, no magic).
 */

${typeImport}${ts ? "import type { AppConfig } from '../config/index.js';\n" : ""}import { openApiPlugin, scalarPlugin } from '@classytic/arc/docs';
`;

  content += `
/**
 * Register all app-specific plugins
 *
 * @param app - Fastify instance
 * @param deps - Explicit dependencies (config, services, etc.)
 */
export async function registerPlugins(
  app${appType},
  deps${configType}
)${ts ? ": Promise<void>" : ""} {
  // NOTE: no error handler here — arc registers it inside createApp().
  // Configure it via createApp({ errorHandler: { includeStack } }) in app.ts.
  // Registering it again would override arc's in the same scope (FSTWRN004).

  // API Documentation (Scalar UI)
  // OpenAPI spec: /_docs/openapi.json
  // Scalar UI: /docs
  await app.register(openApiPlugin, {
    title: '${config.name} API',
    version: '1.0.0',
    description: 'API documentation for ${config.name}',
    apiPrefix: '/api',
  });
  await app.register(scalarPlugin, {
    routePrefix: '/docs',
    theme: 'default',
  });

  // Add your custom plugins here — deps carries your config and services:
  // const { config } = deps;
  // await app.register(myCustomPlugin, { apiKey: config.someKey });
}
`;

  return content;
}
