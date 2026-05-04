/**
 * OpenAPI Spec Generator
 *
 * Auto-generates OpenAPI 3.0 specification from Arc's resource registry.
 *
 * @example
 * import { openApiPlugin } from '@classytic/arc/docs';
 *
 * await fastify.register(openApiPlugin, {
 *   title: 'My API',
 *   version: '1.0.0',
 * });
 *
 * // Spec available at /_docs/openapi.json
 *
 * @example
 * import { buildOpenApiSpec } from '@classytic/arc/docs';
 *
 * const spec = buildOpenApiSpec(resources, {
 *   title: 'My API',
 *   version: '1.0.0',
 *   apiPrefix: '/api/v1',
 * });
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { getUserRoles } from "../../permissions/types.js";
import type { FastifyWithDecorators, RegistryEntry } from "../../types/index.js";
import type { ExternalOpenApiPaths } from "../externalPaths.js";
import { generateSchemas } from "./components.js";
import { generateResourcePaths } from "./paths.js";
import type {
  OpenApiBuildOptions,
  OpenApiOptions,
  OpenApiSpec,
  PathItem,
  SchemaObject,
  SecurityScheme,
} from "./types.js";

const openApiPlugin: FastifyPluginAsync<OpenApiOptions> = async (
  fastify: FastifyInstance,
  opts: OpenApiOptions = {},
) => {
  const {
    title = "Arc API",
    version = "1.0.0",
    description,
    serverUrl,
    prefix = "/_docs",
    apiPrefix = "",
    authRoles = [],
  } = opts;

  // Build spec from instance-scoped registry
  const buildSpec = (): OpenApiSpec => {
    const arc = (fastify as unknown as FastifyWithDecorators).arc;
    const resources = arc?.registry?.getAll() ?? [];
    const externalPaths = arc?.externalOpenApiPaths ?? [];
    return buildOpenApiSpec(
      resources,
      {
        title,
        version,
        description,
        serverUrl,
        apiPrefix,
      },
      externalPaths.length > 0 ? externalPaths : undefined,
    );
  };

  // Serve OpenAPI spec
  fastify.get(`${prefix}/openapi.json`, async (request, reply) => {
    // Check auth if required
    if (authRoles.length > 0) {
      const user = (request as { user?: Record<string, unknown> }).user;
      const roles = getUserRoles(user);
      if (!authRoles.some((r) => roles.includes(r)) && !roles.includes("superadmin")) {
        reply.code(403).send({ error: "Access denied" });
        return;
      }
    }

    const spec = buildSpec();
    // Return object directly - let Fastify handle serialization & compression
    return spec;
  });

  fastify.log?.debug?.(`OpenAPI spec available at ${prefix}/openapi.json`);
};

/**
 * Build OpenAPI spec from registry resources.
 * Shared by HTTP docs endpoint and CLI export command.
 */
export function buildOpenApiSpec(
  resources: RegistryEntry[],
  options: OpenApiBuildOptions = {},
  externalPaths?: ExternalOpenApiPaths[],
): OpenApiSpec {
  const { title = "Arc API", version = "1.0.0", description, serverUrl, apiPrefix = "" } = options;

  const paths: Record<string, PathItem> = {};
  const tags: Array<{ name: string; description?: string }> = [];

  // Collect additional security alternatives from external integrations.
  // Each item is OR'd with bearerAuth on authenticated resource operations.
  const additionalSecurity = externalPaths?.flatMap((ext) => ext.resourceSecurity ?? []) ?? [];

  for (const resource of resources) {
    // Build tag description with preset/pipeline info
    const tagDescParts = [`${resource.displayName || resource.name} operations`];
    if (resource.presets && resource.presets.length > 0) {
      tagDescParts.push(`Presets: ${resource.presets.join(", ")}`);
    }
    if (resource.pipelineSteps && resource.pipelineSteps.length > 0) {
      const stepNames = resource.pipelineSteps.map((s) => `${s.type}(${s.name})`);
      tagDescParts.push(`Pipeline: ${stepNames.join(" → ")}`);
    }
    if (resource.events && resource.events.length > 0) {
      tagDescParts.push(`Events: ${resource.events.join(", ")}`);
    }

    tags.push({
      name: resource.tag || resource.name,
      description: tagDescParts.join(". "),
    });

    const resourcePaths = generateResourcePaths(resource, apiPrefix, additionalSecurity);
    Object.assign(paths, resourcePaths);
  }

  // Merge external paths (Better Auth, custom integrations, etc.)
  if (externalPaths) {
    for (const ext of externalPaths) {
      for (const [path, methods] of Object.entries(ext.paths)) {
        paths[path] = paths[path]
          ? ({ ...paths[path], ...methods } as PathItem)
          : (methods as PathItem);
      }
      if (ext.tags) {
        for (const tag of ext.tags) {
          if (!tags.find((t) => t.name === tag.name)) {
            tags.push(tag);
          }
        }
      }
    }
  }

  // Merge external security schemes and schemas
  const externalSecuritySchemes =
    externalPaths?.reduce<Record<string, Record<string, unknown>>>(
      (acc, ext) => ({ ...acc, ...ext.securitySchemes }),
      {},
    ) ?? {};
  const externalSchemas =
    externalPaths?.reduce<Record<string, Record<string, unknown>>>(
      (acc, ext) => ({ ...acc, ...ext.schemas }),
      {},
    ) ?? {};

  return {
    openapi: "3.0.3",
    info: {
      title,
      version,
      ...(description && { description }),
    },
    ...(serverUrl && {
      servers: [{ url: serverUrl }],
    }),
    paths,
    components: {
      schemas: {
        ...generateSchemas(resources),
        ...externalSchemas,
      } as Record<string, SchemaObject>,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
        orgHeader: {
          type: "apiKey",
          in: "header",
          name: "x-organization-id",
        },
        // Plugin-specific schemes (e.g. apiKeyAuth) are auto-detected
        // and injected via externalSecuritySchemes from the auth extractor.
        ...externalSecuritySchemes,
      } as Record<string, SecurityScheme>,
    },
    tags,
  };
}

export type { OpenApiBuildOptions, OpenApiOptions, OpenApiSpec } from "./types.js";

export default fp(openApiPlugin, {
  name: "arc-openapi",
  fastify: "5.x",
});

export { openApiPlugin };
