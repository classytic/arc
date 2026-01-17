/**
 * Arc CLI - Docs Command
 *
 * Export OpenAPI specification from registered resources
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegistryEntry } from '../../types/index.js';

interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  paths: Record<string, any>;
  components: {
    schemas: Record<string, any>;
    securitySchemes: Record<string, any>;
  };
}

export async function exportDocs(args: string[]): Promise<void> {
  const [outputPath = './openapi.json'] = args;

  console.log('Exporting OpenAPI specification...\n');

  try {
    // Import the resource registry
    const { resourceRegistry } = await import('../../registry/index.js');

    const resources: RegistryEntry[] = resourceRegistry.getAll();

    if (resources.length === 0) {
      console.warn('⚠️  No resources registered.');
      console.log('\nTo export docs, you need to load your resources first:');
      console.log('  arc docs ./openapi.json --entry ./index.js');
      console.log('\nWhere index.js imports all your resource definitions.');
      process.exit(1);
    }

    // Build OpenAPI spec
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      info: {
        title: 'Arc API',
        version: '1.0.0',
        description: 'Auto-generated from Arc resources',
      },
      servers: [
        {
          url: 'http://localhost:8040/api/v1',
          description: 'Development server',
        },
      ],
      paths: {},
      components: {
        schemas: {},
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    };

    // Generate paths for each resource
    resources.forEach((resource) => {
      const basePath = resource.prefix || `/${resource.name}s`;

      // List endpoint
      spec.paths[basePath] = {
        get: {
          tags: [resource.name],
          summary: `List ${resource.name}s`,
          security: resource.permissions?.list ? [{ bearerAuth: [] }] : [],
          parameters: [
            {
              name: 'page',
              in: 'query',
              schema: { type: 'integer', default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 20 },
            },
          ],
          responses: {
            200: {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: { $ref: `#/components/schemas/${resource.name}` },
                      },
                      total: { type: 'integer' },
                      page: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: [resource.name],
          summary: `Create ${resource.name}`,
          security: resource.permissions?.create ? [{ bearerAuth: [] }] : [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${resource.name}` },
              },
            },
          },
          responses: {
            201: {
              description: 'Created successfully',
            },
          },
        },
      };

      // Single item endpoints
      spec.paths[`${basePath}/{id}`] = {
        get: {
          tags: [resource.name],
          summary: `Get ${resource.name} by ID`,
          security: resource.permissions?.get ? [{ bearerAuth: [] }] : [],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'Successful response',
            },
          },
        },
        patch: {
          tags: [resource.name],
          summary: `Update ${resource.name}`,
          security: resource.permissions?.update ? [{ bearerAuth: [] }] : [],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${resource.name}` },
              },
            },
          },
          responses: {
            200: {
              description: 'Updated successfully',
            },
          },
        },
        delete: {
          tags: [resource.name],
          summary: `Delete ${resource.name}`,
          security: resource.permissions?.delete ? [{ bearerAuth: [] }] : [],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'Deleted successfully',
            },
          },
        },
      };

      // Add schema placeholder
      spec.components.schemas[resource.name] = {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      };
    });

    // Write to file
    const fullPath = join(process.cwd(), outputPath);
    writeFileSync(fullPath, JSON.stringify(spec, null, 2));

    console.log(`✅ OpenAPI spec exported to: ${fullPath}`);
    console.log(`\nResources included: ${resources.length}`);
    console.log(`Total endpoints: ${Object.keys(spec.paths).length}`);
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

export default { exportDocs };
