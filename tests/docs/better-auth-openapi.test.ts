/**
 * Better Auth OpenAPI Extractor Tests
 *
 * Tests the Better Auth endpoint introspection → OpenAPI spec generation,
 * using real Zod v4 schemas converted via z.toJSONSchema().
 */

import { describe, it, expect, afterAll } from 'vitest';
import { z } from 'zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { extractBetterAuthOpenApi } from '../../src/auth/betterAuthOpenApi.js';
import { buildOpenApiSpec } from '../../src/docs/openapi.js';
import { openApiPlugin } from '../../src/docs/openapi.js';
import { arcCorePlugin } from '../../src/core/arcCorePlugin.js';
import type { ExternalOpenApiPaths } from '../../src/docs/externalPaths.js';

// ============================================================================
// Helpers: Mock Better Auth endpoint
// ============================================================================

function mockEndpoint(path: string, opts: Record<string, unknown> = {}) {
  const fn = () => {};
  (fn as any).path = path;
  (fn as any).options = {
    method: 'POST',
    ...opts,
  };
  return fn;
}

// ============================================================================
// extractBetterAuthOpenApi with real Zod v4 schemas
// ============================================================================

describe('extractBetterAuthOpenApi (Zod v4 schemas)', () => {
  it('generates POST request body from Zod v4 body schema', () => {
    const mockApi = {
      signInEmail: mockEndpoint('/sign-in/email', {
        method: 'POST',
        body: z.object({
          email: z.string().email(),
          password: z.string(),
          rememberMe: z.boolean().default(true),
        }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-in/email']?.post as any;

    expect(postOp).toBeDefined();
    expect(postOp.requestBody).toBeDefined();

    const schema = postOp.requestBody.content['application/json'].schema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        email: expect.objectContaining({ type: 'string', format: 'email' }),
        password: { type: 'string' },
        rememberMe: expect.objectContaining({ type: 'boolean', default: true }),
      },
    });
    // All fields are in required (Zod v4 treats default fields as required in JSON Schema)
    expect(schema.required).toEqual(expect.arrayContaining(['email', 'password', 'rememberMe']));
  });

  it('generates query params from Zod v4 query schema', () => {
    const mockApi = {
      listSessions: mockEndpoint('/list-sessions', {
        method: 'GET',
        query: z.object({
          page: z.optional(z.number()),
          limit: z.optional(z.number()),
        }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const getOp = result.paths['/api/auth/list-sessions']?.get as any;

    expect(getOp.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'page', in: 'query', required: false }),
        expect.objectContaining({ name: 'limit', in: 'query', required: false }),
      ]),
    );
  });

  it('handles Zod intersection body (Better Auth signUpEmail pattern)', () => {
    const mockApi = {
      signUpEmail: mockEndpoint('/sign-up/email', {
        method: 'POST',
        body: z.intersection(
          z.object({
            name: z.string(),
            email: z.string().email(),
            password: z.string(),
          }),
          z.record(z.string(), z.string()),
        ),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-up/email']?.post as any;

    expect(postOp).toBeDefined();
    expect(postOp.requestBody).toBeDefined();

    const schema = postOp.requestBody.content['application/json'].schema;
    // Native z.toJSONSchema produces allOf for intersections
    expect(schema.allOf).toBeDefined();
    expect(schema.allOf.length).toBe(2);
  });
});

// ============================================================================
// extractBetterAuthOpenApi — general tests
// ============================================================================

describe('extractBetterAuthOpenApi', () => {
  it('extracts paths from mock auth.api endpoints', () => {
    const mockApi = {
      signInEmail: mockEndpoint('/sign-in/email', {
        method: 'POST',
        body: z.object({
          email: z.string().email(),
          password: z.string(),
        }),
      }),
      signUpEmail: mockEndpoint('/sign-up/email', {
        method: 'POST',
        body: z.object({
          email: z.string().email(),
          password: z.string(),
          name: z.string(),
        }),
      }),
      getSession: mockEndpoint('/get-session', {
        method: 'GET',
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);

    // Should have 3 paths
    expect(Object.keys(result.paths)).toHaveLength(3);
    expect(result.paths['/api/auth/sign-in/email']).toBeDefined();
    expect(result.paths['/api/auth/sign-up/email']).toBeDefined();
    expect(result.paths['/api/auth/get-session']).toBeDefined();
  });

  it('generates POST operations with request body from Zod schema', () => {
    const mockApi = {
      signInEmail: mockEndpoint('/sign-in/email', {
        method: 'POST',
        body: z.object({
          email: z.string().email(),
          password: z.string(),
        }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-in/email']?.post as any;

    expect(postOp).toBeDefined();
    expect(postOp.requestBody).toBeDefined();

    const schema = postOp.requestBody.content['application/json'].schema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        email: expect.objectContaining({ type: 'string', format: 'email' }),
        password: { type: 'string' },
      },
    });
    expect(schema.required).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('generates GET operations without request body', () => {
    const mockApi = {
      getSession: mockEndpoint('/get-session', { method: 'GET' }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const getOp = result.paths['/api/auth/get-session']?.get as any;

    expect(getOp).toBeDefined();
    expect(getOp.requestBody).toBeUndefined();
  });

  it('converts :param paths to {param} (OpenAPI format)', () => {
    const mockApi = {
      verifyEmail: mockEndpoint('/verify-email/:token', { method: 'GET' }),
    };

    const result = extractBetterAuthOpenApi(mockApi);

    expect(result.paths['/api/auth/verify-email/{token}']).toBeDefined();
    const getOp = result.paths['/api/auth/verify-email/{token}']?.get as any;
    expect(getOp.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'token', in: 'path', required: true }),
      ]),
    );
  });

  it('uses custom basePath', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
    };

    const result = extractBetterAuthOpenApi(mockApi, { basePath: '/auth' });
    expect(result.paths['/auth/sign-in']).toBeDefined();
  });

  it('excludes SERVER_ONLY endpoints by default', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
      internalEndpoint: mockEndpoint('/internal', {
        method: 'POST',
        metadata: { SERVER_ONLY: true },
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    expect(Object.keys(result.paths)).toHaveLength(1);
    expect(result.paths['/api/auth/sign-in']).toBeDefined();
    expect(result.paths['/api/auth/internal']).toBeUndefined();
  });

  it('includes SERVER_ONLY endpoints when excludeServerOnly is false', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
      internalEndpoint: mockEndpoint('/internal', {
        method: 'POST',
        metadata: { SERVER_ONLY: true },
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi, { excludeServerOnly: false });
    expect(Object.keys(result.paths)).toHaveLength(2);
  });

  it('respects excludePaths filter', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
      ok: mockEndpoint('/ok', { method: 'GET' }),
      error: mockEndpoint('/error', { method: 'GET' }),
    };

    const result = extractBetterAuthOpenApi(mockApi, {
      excludePaths: ['/ok', '/error'],
    });

    expect(Object.keys(result.paths)).toHaveLength(1);
    expect(result.paths['/api/auth/sign-in']).toBeDefined();
  });

  it('adds cookieAuth security scheme', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
    };

    const result = extractBetterAuthOpenApi(mockApi);

    expect(result.securitySchemes).toBeDefined();
    expect(result.securitySchemes!.cookieAuth).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'better-auth.session_token',
      description: 'Session cookie set by Better Auth after sign-in',
    });
  });

  it('generates tags with custom name and description', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
    };

    const result = extractBetterAuthOpenApi(mockApi, {
      tagName: 'Auth',
      tagDescription: 'Custom auth endpoints',
    });

    expect(result.tags).toEqual([
      { name: 'Auth', description: 'Custom auth endpoints' },
    ]);
  });

  it('uses metadata.openapi for summary/description', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', {
        method: 'POST',
        metadata: {
          openapi: {
            summary: 'Sign in with email',
            description: 'Authenticate using email and password',
            operationId: 'auth_signIn',
          },
        },
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-in']?.post as any;

    expect(postOp.summary).toBe('Sign in with email');
    expect(postOp.description).toBe('Authenticate using email and password');
    expect(postOp.operationId).toBe('auth_signIn');
  });

  it('adds security to each operation', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-in']?.post as any;

    expect(postOp.security).toEqual([
      { cookieAuth: [] },
      { bearerAuth: [] },
    ]);
  });

  it('handles endpoints with multiple methods', () => {
    const mockApi = {
      session: mockEndpoint('/session', {
        method: ['GET', 'DELETE'],
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const path = result.paths['/api/auth/session'] as any;

    expect(path.get).toBeDefined();
    expect(path.delete).toBeDefined();
  });

  it('defaults method to POST when body exists', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', {
        body: z.object({ email: z.string() }),
      }),
    };

    // Remove the method from options
    delete (mockApi.signIn as any).options.method;

    const result = extractBetterAuthOpenApi(mockApi);
    expect(result.paths['/api/auth/sign-in']?.post).toBeDefined();
  });

  it('defaults method to GET when no body', () => {
    const mockApi = {
      getSession: mockEndpoint('/get-session', {}),
    };

    // Remove the method from options
    delete (mockApi.getSession as any).options.method;

    const result = extractBetterAuthOpenApi(mockApi);
    expect(result.paths['/api/auth/get-session']?.get).toBeDefined();
  });

  it('returns empty paths for empty api object', () => {
    const result = extractBetterAuthOpenApi({});
    expect(Object.keys(result.paths)).toHaveLength(0);
  });

  it('skips non-endpoint values in api object', () => {
    const mockApi = {
      signIn: mockEndpoint('/sign-in', { method: 'POST' }),
      someHelper: () => {},
      someString: 'not-an-endpoint',
      someNumber: 42,
      someNull: null,
    };

    const result = extractBetterAuthOpenApi(mockApi as any);
    expect(Object.keys(result.paths)).toHaveLength(1);
  });

  it('handles query parameters for GET endpoints', () => {
    const mockApi = {
      listSessions: mockEndpoint('/list-sessions', {
        method: 'GET',
        query: z.object({
          page: z.optional(z.number()),
          limit: z.optional(z.number()),
        }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const getOp = result.paths['/api/auth/list-sessions']?.get as any;

    expect(getOp.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'page', in: 'query', required: false }),
        expect.objectContaining({ name: 'limit', in: 'query', required: false }),
      ]),
    );
  });
});

// ============================================================================
// metadata.openapi.requestBody preference
// ============================================================================

describe('extractBetterAuthOpenApi — metadata.openapi.requestBody', () => {
  it('prefers metadata.openapi.requestBody over Zod body conversion', () => {
    const mockApi = {
      signUpEmail: mockEndpoint('/sign-up/email', {
        method: 'POST',
        body: z.intersection(
          z.object({ name: z.string() }),
          z.record(z.string(), z.any()),
        ),
        metadata: {
          openapi: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'User display name' },
                      email: { type: 'string', format: 'email' },
                      password: { type: 'string' },
                    },
                    required: ['name', 'email', 'password'],
                  },
                },
              },
            },
          },
        },
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-up/email']?.post as any;
    const schema = postOp.requestBody.content['application/json'].schema;

    // Should use metadata schema (clean properties), not Zod (allOf)
    expect(schema.allOf).toBeUndefined();
    expect(schema.properties.name).toEqual({ type: 'string', description: 'User display name' });
    expect(schema.required).toEqual(['name', 'email', 'password']);
  });

  it('falls back to Zod body when no metadata.openapi.requestBody', () => {
    const mockApi = {
      signInEmail: mockEndpoint('/sign-in/email', {
        method: 'POST',
        body: z.object({ email: z.string().email(), password: z.string() }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-in/email']?.post as any;
    const schema = postOp.requestBody.content['application/json'].schema;

    // Should use Zod conversion
    expect(schema.type).toBe('object');
    expect(schema.properties.email).toMatchObject({ type: 'string', format: 'email' });
  });

  it('does not mutate original metadata.openapi.requestBody', () => {
    const originalRequestBody = {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    };

    const mockApi = {
      signUpEmail: mockEndpoint('/sign-up/email', {
        method: 'POST',
        metadata: { openapi: { requestBody: originalRequestBody } },
      }),
    };

    extractBetterAuthOpenApi(mockApi, {
      userFields: { department: { type: 'string' } },
    });

    // Original should not have department merged into it
    const origProps = originalRequestBody.content['application/json'].schema.properties;
    expect((origProps as any).department).toBeUndefined();
  });
});

// ============================================================================
// userFields merging
// ============================================================================

describe('extractBetterAuthOpenApi — userFields', () => {
  it('merges userFields into signUpEmail request body', () => {
    const mockApi = {
      signUpEmail: mockEndpoint('/sign-up/email', {
        method: 'POST',
        body: z.object({ name: z.string(), email: z.string(), password: z.string() }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi, {
      userFields: {
        department: { type: 'string', description: 'Department', required: true },
        roles: { type: 'array', description: 'User roles', input: false },
      },
    });

    const postOp = result.paths['/api/auth/sign-up/email']?.post as any;
    const schema = postOp.requestBody.content['application/json'].schema;

    // department should be merged (input defaults to true)
    expect(schema.properties.department).toEqual({ type: 'string', description: 'Department' });
    // department should be required
    expect(schema.required).toContain('department');
    // roles should NOT be merged (input: false)
    expect(schema.properties.roles).toBeUndefined();
  });

  it('makes userFields optional in updateUser request body', () => {
    const mockApi = {
      updateUser: mockEndpoint('/update-user', {
        method: 'POST',
        body: z.object({ name: z.optional(z.string()) }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi, {
      userFields: {
        department: { type: 'string', required: true },
      },
    });

    const postOp = result.paths['/api/auth/update-user']?.post as any;
    const schema = postOp.requestBody.content['application/json'].schema;

    // department should be in properties but NOT required (updateUser = all optional)
    expect(schema.properties.department).toBeDefined();
    expect(schema.required || []).not.toContain('department');
  });

  it('does not merge userFields into unrelated endpoints', () => {
    const mockApi = {
      signInEmail: mockEndpoint('/sign-in/email', {
        method: 'POST',
        body: z.object({ email: z.string(), password: z.string() }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi, {
      userFields: {
        department: { type: 'string' },
      },
    });

    const postOp = result.paths['/api/auth/sign-in/email']?.post as any;
    const schema = postOp.requestBody.content['application/json'].schema;

    expect(schema.properties.department).toBeUndefined();
  });
});

// ============================================================================
// User/Session component schemas
// ============================================================================

describe('extractBetterAuthOpenApi — component schemas', () => {
  it('includes User and Session component schemas', () => {
    const mockApi = {
      getSession: mockEndpoint('/get-session', { method: 'GET' }),
    };

    const result = extractBetterAuthOpenApi(mockApi);

    expect(result.schemas?.User).toBeDefined();
    expect(result.schemas?.User?.properties).toMatchObject({
      id: { type: 'string' },
      email: expect.objectContaining({ type: 'string', format: 'email' }),
      name: { type: 'string' },
    });

    expect(result.schemas?.Session).toBeDefined();
    expect(result.schemas?.Session?.properties).toMatchObject({
      token: { type: 'string' },
      userId: { type: 'string' },
    });
  });

  it('merges userFields into User component schema (including input: false)', () => {
    const result = extractBetterAuthOpenApi({}, {
      userFields: {
        department: { type: 'string', description: 'Department' },
        roles: { type: 'array', description: 'User roles', input: false },
      },
    });

    const userProps = result.schemas?.User?.properties as any;

    // Both input and non-input fields appear in User schema (it's the response shape)
    expect(userProps.department).toEqual({ type: 'string', description: 'Department' });
    expect(userProps.roles).toEqual({ type: 'array', description: 'User roles' });
  });

  it('component schemas resolve $ref in responses', () => {
    const mockApi = {
      getSession: mockEndpoint('/get-session', {
        method: 'GET',
        metadata: {
          openapi: {
            responses: {
              '200': {
                description: 'Success',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
        },
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);

    // The response uses $ref
    const getOp = result.paths['/api/auth/get-session']?.get as any;
    expect(getOp.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/User');

    // The component schema exists to resolve it
    expect(result.schemas?.User).toBeDefined();
    expect(result.schemas?.User?.properties).toHaveProperty('id');
    expect(result.schemas?.User?.properties).toHaveProperty('email');
  });
});

// ============================================================================
// Integration: buildOpenApiSpec + externalPaths
// ============================================================================

describe('buildOpenApiSpec with externalPaths', () => {
  it('merges external paths alongside resource paths', () => {
    const externalPaths: ExternalOpenApiPaths = {
      paths: {
        '/api/auth/sign-in': {
          post: {
            tags: ['Authentication'],
            summary: 'Sign in',
            operationId: 'signIn',
            responses: { '200': { description: 'Success' } },
          },
        },
      },
      tags: [{ name: 'Authentication', description: 'Auth endpoints' }],
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session_token' },
      },
    };

    const spec = buildOpenApiSpec([], {}, [externalPaths]);

    // Auth path should be in the spec
    expect(spec.paths['/api/auth/sign-in']).toBeDefined();
    expect((spec.paths['/api/auth/sign-in'] as any).post.summary).toBe('Sign in');

    // Auth tag should be merged
    expect(spec.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Authentication' }),
      ]),
    );

    // Cookie auth security scheme should be merged
    expect(spec.components.securitySchemes?.cookieAuth).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'session_token',
    });

    // Built-in security schemes should still be present
    expect(spec.components.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes?.orgHeader).toBeDefined();
  });

  it('does not duplicate tags', () => {
    const ext1: ExternalOpenApiPaths = {
      paths: {},
      tags: [{ name: 'Auth' }],
    };
    const ext2: ExternalOpenApiPaths = {
      paths: {},
      tags: [{ name: 'Auth' }, { name: 'Other' }],
    };

    const spec = buildOpenApiSpec([], {}, [ext1, ext2]);

    const authTags = spec.tags.filter((t) => t.name === 'Auth');
    expect(authTags).toHaveLength(1);
    expect(spec.tags.find((t) => t.name === 'Other')).toBeDefined();
  });

  it('merges external schemas', () => {
    const ext: ExternalOpenApiPaths = {
      paths: {},
      schemas: {
        UserSession: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            token: { type: 'string' },
          },
        },
      },
    };

    const spec = buildOpenApiSpec([], {}, [ext]);

    expect((spec.components.schemas as any).UserSession).toBeDefined();
    expect((spec.components.schemas as any).UserSession.properties.userId).toEqual({
      type: 'string',
    });
  });

  it('works with undefined externalPaths (backwards compat)', () => {
    const spec = buildOpenApiSpec([]);
    expect(spec.paths).toEqual({});
    expect(spec.components.securitySchemes?.bearerAuth).toBeDefined();
  });

  it('works with empty externalPaths array', () => {
    const spec = buildOpenApiSpec([], {}, []);
    // Should not crash or add extra entries
    expect(spec.paths).toEqual({});
  });
});

// ============================================================================
// Runtime Integration: openApiPlugin serves Better Auth paths
// ============================================================================

describe('openApiPlugin runtime with externalOpenApiPaths', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app) await app.close();
  });

  it('serves auth endpoints in /_docs/openapi.json when externalOpenApiPaths is populated', async () => {
    app = Fastify({ logger: false });

    // Register arc core (provides fastify.arc with externalOpenApiPaths)
    await app.register(arcCorePlugin, { emitEvents: false });

    // Simulate what Better Auth adapter does: push external paths
    app.arc.externalOpenApiPaths.push({
      paths: {
        '/api/auth/sign-in/email': {
          post: {
            tags: ['Authentication'],
            summary: 'Sign in with email',
            operationId: 'signInEmail',
            security: [{ cookieAuth: [] }, { bearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: { type: 'string', format: 'email' },
                      password: { type: 'string' },
                    },
                    required: ['email', 'password'],
                  },
                },
              },
            },
            responses: {
              '200': { description: 'Success' },
              '400': { description: 'Bad request' },
              '401': { description: 'Unauthorized' },
            },
          },
        },
        '/api/auth/sign-up/email': {
          post: {
            tags: ['Authentication'],
            summary: 'Sign up with email',
            operationId: 'signUpEmail',
            responses: { '200': { description: 'Success' } },
          },
        },
        '/api/auth/get-session': {
          get: {
            tags: ['Authentication'],
            summary: 'Get session',
            operationId: 'getSession',
            responses: { '200': { description: 'Success' } },
          },
        },
      },
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
        },
      },
      tags: [{ name: 'Authentication', description: 'Better Auth endpoints' }],
    });

    // Register openApi plugin
    await app.register(openApiPlugin, {
      title: 'Test API',
      version: '1.0.0',
    });

    await app.ready();

    // Fetch the spec
    const response = await app.inject({
      method: 'GET',
      url: '/_docs/openapi.json',
    });

    expect(response.statusCode).toBe(200);

    const spec = JSON.parse(response.body);

    // Auth paths should appear
    expect(spec.paths['/api/auth/sign-in/email']).toBeDefined();
    expect(spec.paths['/api/auth/sign-in/email'].post.summary).toBe('Sign in with email');
    expect(spec.paths['/api/auth/sign-up/email']).toBeDefined();
    expect(spec.paths['/api/auth/get-session']).toBeDefined();

    // Request body schema should be present
    const signInBody = spec.paths['/api/auth/sign-in/email'].post.requestBody;
    expect(signInBody.content['application/json'].schema.properties.email).toEqual({
      type: 'string',
      format: 'email',
    });

    // Cookie auth security scheme should be merged
    expect(spec.components.securitySchemes.cookieAuth).toBeDefined();
    expect(spec.components.securitySchemes.cookieAuth.in).toBe('cookie');

    // Built-in schemes should still be present
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.orgHeader).toBeDefined();

    // Authentication tag should appear
    expect(spec.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Authentication' }),
      ]),
    );
  });

  it('serves clean spec when no external paths are added', async () => {
    const cleanApp = Fastify({ logger: false });

    await cleanApp.register(arcCorePlugin, { emitEvents: false });
    await cleanApp.register(openApiPlugin, { title: 'Clean API' });
    await cleanApp.ready();

    const response = await cleanApp.inject({
      method: 'GET',
      url: '/_docs/openapi.json',
    });

    const spec = JSON.parse(response.body);

    // No auth paths
    expect(spec.paths['/api/auth/sign-in/email']).toBeUndefined();

    // Built-in security schemes still present
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();

    // No Authentication tag
    expect(spec.tags.find((t: any) => t.name === 'Authentication')).toBeUndefined();

    await cleanApp.close();
  });
});
