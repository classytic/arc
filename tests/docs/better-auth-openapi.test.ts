/**
 * Better Auth OpenAPI Extractor Tests
 *
 * Tests the duck-typed Zod → JSON Schema converter,
 * the Better Auth endpoint introspection → OpenAPI spec generation,
 * and the runtime openApiPlugin serving merged specs.
 */

import { describe, it, expect, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { extractBetterAuthOpenApi, zodLikeToJsonSchema } from '../../src/auth/betterAuthOpenApi.js';
import { buildOpenApiSpec } from '../../src/docs/openapi.js';
import { openApiPlugin } from '../../src/docs/openapi.js';
import { arcCorePlugin } from '../../src/core/arcCorePlugin.js';
import type { ExternalOpenApiPaths } from '../../src/docs/externalPaths.js';

// ============================================================================
// Helpers: Mock Zod-like objects (duck-typed)
// ============================================================================

function zodString(checks?: Array<{ kind: string }>) {
  return { _def: { typeName: 'ZodString', checks: checks ?? [] } };
}

function zodNumber() {
  return { _def: { typeName: 'ZodNumber' } };
}

function zodBoolean() {
  return { _def: { typeName: 'ZodBoolean' } };
}

function zodDate() {
  return { _def: { typeName: 'ZodDate' } };
}

function zodEnum(values: string[]) {
  return { _def: { typeName: 'ZodEnum', values } };
}

function zodArray(itemType: unknown) {
  return { _def: { typeName: 'ZodArray', type: itemType } };
}

function zodOptional(innerType: unknown) {
  return { _def: { typeName: 'ZodOptional', innerType } };
}

function zodDefault(innerType: unknown, defaultValue: unknown) {
  return { _def: { typeName: 'ZodDefault', innerType, defaultValue } };
}

function zodNullable(innerType: unknown) {
  return { _def: { typeName: 'ZodNullable', innerType } };
}

function zodObject(shapeEntries: Record<string, unknown>) {
  return {
    _def: { typeName: 'ZodObject' },
    shape: shapeEntries,
  };
}

function zodObjectWithFnShape(shapeEntries: Record<string, unknown>) {
  return {
    _def: { typeName: 'ZodObject' },
    shape: () => shapeEntries,
  };
}

function zodLiteral(value: unknown) {
  return { _def: { typeName: 'ZodLiteral', value } };
}

function zodRecord(valueType: unknown) {
  return { _def: { typeName: 'ZodRecord', valueType } };
}

function zodUnion(options: unknown[]) {
  return { _def: { typeName: 'ZodUnion', options } };
}

function zodEffects(innerSchema: unknown) {
  return { _def: { typeName: 'ZodEffects', schema: innerSchema } };
}

function zodPipeline(innerSchema: unknown) {
  return { _def: { typeName: 'ZodPipeline', in: innerSchema } };
}

function zodLazy(getter: () => unknown) {
  return { _def: { typeName: 'ZodLazy', getter } };
}

function zodNativeEnum(values: Record<string, unknown>) {
  return { _def: { typeName: 'ZodNativeEnum', values } };
}

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
// zodLikeToJsonSchema
// ============================================================================

describe('zodLikeToJsonSchema', () => {
  it('returns undefined for non-Zod values', () => {
    expect(zodLikeToJsonSchema(null)).toBeUndefined();
    expect(zodLikeToJsonSchema(undefined)).toBeUndefined();
    expect(zodLikeToJsonSchema('hello')).toBeUndefined();
    expect(zodLikeToJsonSchema(42)).toBeUndefined();
    expect(zodLikeToJsonSchema({})).toBeUndefined();
  });

  it('converts ZodString to { type: "string" }', () => {
    expect(zodLikeToJsonSchema(zodString())).toEqual({ type: 'string' });
  });

  it('converts ZodString with email check', () => {
    expect(zodLikeToJsonSchema(zodString([{ kind: 'email' }]))).toEqual({
      type: 'string',
      format: 'email',
    });
  });

  it('converts ZodString with url check', () => {
    expect(zodLikeToJsonSchema(zodString([{ kind: 'url' }]))).toEqual({
      type: 'string',
      format: 'uri',
    });
  });

  it('converts ZodString with uuid check', () => {
    expect(zodLikeToJsonSchema(zodString([{ kind: 'uuid' }]))).toEqual({
      type: 'string',
      format: 'uuid',
    });
  });

  it('converts ZodNumber to { type: "number" }', () => {
    expect(zodLikeToJsonSchema(zodNumber())).toEqual({ type: 'number' });
  });

  it('converts ZodBoolean to { type: "boolean" }', () => {
    expect(zodLikeToJsonSchema(zodBoolean())).toEqual({ type: 'boolean' });
  });

  it('converts ZodDate to { type: "string", format: "date-time" }', () => {
    expect(zodLikeToJsonSchema(zodDate())).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  it('converts ZodEnum', () => {
    expect(zodLikeToJsonSchema(zodEnum(['a', 'b', 'c']))).toEqual({
      type: 'string',
      enum: ['a', 'b', 'c'],
    });
  });

  it('converts ZodNativeEnum', () => {
    expect(zodLikeToJsonSchema(zodNativeEnum({ A: 'a', B: 'b' }))).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    });
  });

  it('converts ZodArray', () => {
    expect(zodLikeToJsonSchema(zodArray(zodString()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts ZodOptional (unwraps inner)', () => {
    expect(zodLikeToJsonSchema(zodOptional(zodNumber()))).toEqual({
      type: 'number',
    });
  });

  it('converts ZodDefault (unwraps + adds default)', () => {
    expect(zodLikeToJsonSchema(zodDefault(zodString(), 'hello'))).toEqual({
      type: 'string',
      default: 'hello',
    });
  });

  it('converts ZodDefault with function defaultValue', () => {
    expect(zodLikeToJsonSchema(zodDefault(zodNumber(), () => 42))).toEqual({
      type: 'number',
      default: 42,
    });
  });

  it('converts ZodNullable (unwraps inner)', () => {
    expect(zodLikeToJsonSchema(zodNullable(zodBoolean()))).toEqual({
      type: 'boolean',
    });
  });

  it('converts ZodLiteral', () => {
    expect(zodLikeToJsonSchema(zodLiteral('active'))).toEqual({
      type: 'string',
      enum: ['active'],
    });
  });

  it('converts ZodRecord', () => {
    expect(zodLikeToJsonSchema(zodRecord(zodNumber()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('converts ZodUnion', () => {
    const result = zodLikeToJsonSchema(zodUnion([zodString(), zodNumber()]));
    expect(result).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('converts ZodEffects (unwraps)', () => {
    expect(zodLikeToJsonSchema(zodEffects(zodString()))).toEqual({
      type: 'string',
    });
  });

  it('converts ZodPipeline (unwraps)', () => {
    expect(zodLikeToJsonSchema(zodPipeline(zodNumber()))).toEqual({
      type: 'number',
    });
  });

  it('converts ZodLazy (unwraps via getter)', () => {
    expect(zodLikeToJsonSchema(zodLazy(() => zodString()))).toEqual({
      type: 'string',
    });
  });

  it('converts ZodObject with properties', () => {
    const schema = zodObject({
      email: zodString([{ kind: 'email' }]),
      name: zodString(),
      age: zodOptional(zodNumber()),
    });

    const result = zodLikeToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['email', 'name'],
    });
  });

  it('converts ZodObject with function shape', () => {
    const schema = zodObjectWithFnShape({
      token: zodString(),
    });

    const result = zodLikeToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        token: { type: 'string' },
      },
      required: ['token'],
    });
  });

  it('preserves description from _def.description', () => {
    const emailField = zodString([{ kind: 'email' }]);
    (emailField._def as any).description = 'User email address';

    const schema = zodObject({ email: emailField });
    const result = zodLikeToJsonSchema(schema) as any;

    expect(result.properties.email.description).toBe('User email address');
  });

  it('falls back to { type: "object" } for unknown Zod types', () => {
    const unknown = { _def: { typeName: 'ZodSomeNewType' } };
    expect(zodLikeToJsonSchema(unknown)).toEqual({ type: 'object' });
  });
});

// ============================================================================
// extractBetterAuthOpenApi
// ============================================================================

describe('extractBetterAuthOpenApi', () => {
  it('extracts paths from mock auth.api endpoints', () => {
    const mockApi = {
      signInEmail: mockEndpoint('/sign-in/email', {
        method: 'POST',
        body: zodObject({
          email: zodString([{ kind: 'email' }]),
          password: zodString(),
        }),
      }),
      signUpEmail: mockEndpoint('/sign-up/email', {
        method: 'POST',
        body: zodObject({
          email: zodString([{ kind: 'email' }]),
          password: zodString(),
          name: zodString(),
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
        body: zodObject({
          email: zodString([{ kind: 'email' }]),
          password: zodString(),
        }),
      }),
    };

    const result = extractBetterAuthOpenApi(mockApi);
    const postOp = result.paths['/api/auth/sign-in/email']?.post as any;

    expect(postOp).toBeDefined();
    expect(postOp.requestBody).toBeDefined();
    expect(postOp.requestBody.content['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string' },
      },
      required: ['email', 'password'],
    });
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
        body: zodObject({ email: zodString() }),
        // no explicit method
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
        query: zodObject({
          page: zodOptional(zodNumber()),
          limit: zodOptional(zodNumber()),
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
