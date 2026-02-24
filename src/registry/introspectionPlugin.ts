/**
 * Introspection Plugin
 *
 * Exposes resource registry via API endpoints.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IntrospectionPluginOptions, FastifyWithAuth, FastifyWithDecorators } from '../types/index.js';

const introspectionPlugin: FastifyPluginAsync<IntrospectionPluginOptions> = async (
  fastify: FastifyInstance,
  opts: IntrospectionPluginOptions = {}
) => {
  const {
    prefix = '/_resources',
    authRoles = ['superadmin'],
    enabled = true,
  } = opts;

  if (!enabled) {
    fastify.log?.debug?.('Introspection plugin disabled');
    return;
  }

  const typedFastify = fastify as FastifyWithAuth;

  // Build auth middleware array using any to avoid complex Fastify type constraints
  const authMiddleware: unknown[] =
    authRoles.length > 0 && typedFastify.authenticate
      ? [
          typedFastify.authenticate,
          typedFastify.authorize?.(...authRoles),
        ].filter(Boolean)
      : [];

  // Instance-scoped registry access
  const getRegistry = () => (fastify as unknown as FastifyWithDecorators).arc?.registry;

  await fastify.register(async (instance) => {
    // GET / - Get all registered resources
    instance.get(
      '/',
      {
        preHandler: authMiddleware as never,
      },
      async (_req: FastifyRequest, _reply: FastifyReply) => {
        return getRegistry()?.getIntrospection() ?? { resources: [], stats: {}, generatedAt: new Date().toISOString() };
      }
    );

    // GET /stats - Get registry statistics
    instance.get(
      '/stats',
      {
        preHandler: authMiddleware as never,
      },
      async (_req: FastifyRequest, _reply: FastifyReply) => {
        return getRegistry()?.getStats() ?? { totalResources: 0, byModule: {}, presetUsage: {}, totalRoutes: 0, totalEvents: 0 };
      }
    );

    // GET /:name - Get resource by name
    instance.get<{ Params: { name: string } }>(
      '/:name',
      {
        schema: {
          params: {
            type: 'object' as const,
            properties: {
              name: { type: 'string' as const },
            },
            required: ['name' as const],
          },
        },
        preHandler: authMiddleware as never,
      },
      async (req, reply: FastifyReply) => {
        const resource = getRegistry()?.get(req.params.name);
        if (!resource) {
          return reply.code(404).send({
            error: `Resource '${req.params.name}' not found`,
          });
        }
        return resource;
      }
    );
  }, { prefix });

  fastify.log?.debug?.(`Introspection API at ${prefix}`);
};

export default fp(introspectionPlugin, { name: 'arc-introspection' });

export { introspectionPlugin };
export type { IntrospectionPluginOptions };
