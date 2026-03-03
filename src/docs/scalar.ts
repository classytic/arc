/**
 * Scalar API Reference Plugin
 *
 * Beautiful, modern API documentation UI.
 * Lighter and more modern than Swagger UI.
 *
 * @example
 * import { scalarPlugin } from '@classytic/arc/docs';
 *
 * await fastify.register(scalarPlugin, {
 *   routePrefix: '/docs',
 *   specUrl: '/_docs/openapi.json',
 * });
 *
 * // UI available at /docs
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { getUserRoles } from '../permissions/types.js';

export interface ScalarOptions {
  /** Route prefix for UI (default: '/docs') */
  routePrefix?: string;
  /** OpenAPI spec URL (default: '/_docs/openapi.json') */
  specUrl?: string;
  /** Page title */
  title?: string;
  /** Theme (default: 'default') */
  theme?: 'default' | 'alternate' | 'moon' | 'purple' | 'solarized' | 'bluePlanet' | 'saturn' | 'kepler' | 'mars' | 'deepSpace';
  /** Show sidebar (default: true) */
  showSidebar?: boolean;
  /** Dark mode (default: false) */
  darkMode?: boolean;
  /** Auth roles required to access docs */
  authRoles?: string[];
  /** Custom CSS */
  customCss?: string;
  /** Favicon URL */
  favicon?: string;
}

const scalarPlugin: FastifyPluginAsync<ScalarOptions> = async (
  fastify: FastifyInstance,
  opts: ScalarOptions = {}
) => {
  const {
    routePrefix = '/docs',
    specUrl = '/_docs/openapi.json',
    title = 'API Documentation',
    theme = 'default',
    showSidebar = true,
    darkMode = false,
    authRoles = [],
    customCss = '',
    favicon,
  } = opts;

  // Scalar configuration
  const scalarConfig = JSON.stringify({
    spec: { url: specUrl },
    theme,
    showSidebar,
    darkMode,
    ...(favicon && { favicon }),
  });

  // HTML template for Scalar
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${favicon ? `<link rel="icon" href="${favicon}">` : ''}
  <style>
    body { margin: 0; padding: 0; }
    ${customCss}
  </style>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script>
    var configuration = ${scalarConfig};
    document.getElementById('api-reference').dataset.configuration = JSON.stringify(configuration);
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;

  // Serve UI (not included in OpenAPI spec)
  fastify.get(routePrefix, async (request, reply) => {
    // Check auth if required
    if (authRoles.length > 0) {
      const user = (request as { user?: Record<string, unknown> }).user;
      const roles = getUserRoles(user);
      if (!authRoles.some((r) => roles.includes(r)) && !roles.includes('superadmin')) {
        reply.code(403).send({ error: 'Access denied' });
        return;
      }
    }

    reply.type('text/html').send(html);
  });

  // Redirect /docs/ to /docs
  if (!routePrefix.endsWith('/')) {
    fastify.get(`${routePrefix}/`, async (_, reply) => {
      reply.redirect(routePrefix);
    });
  }

  fastify.log?.debug?.(`Scalar API docs available at ${routePrefix}`);
};

export default fp(scalarPlugin, {
  name: 'arc-scalar',
  fastify: '5.x',
});

export { scalarPlugin };
