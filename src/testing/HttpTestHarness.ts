/**
 * HTTP Test Harness
 *
 * Generates HTTP-level CRUD tests for Arc resources using `app.inject()`.
 * Unlike TestHarness (which tests Mongoose models directly), this exercises
 * the full request lifecycle: HTTP routes, auth, permissions, pipeline,
 * field permissions, and the Arc response envelope.
 *
 * Supports both eager and deferred options:
 * - **Eager**: Pass options directly when app is available at construction time
 * - **Deferred**: Pass a getter function when app comes from async setup (beforeAll)
 *
 * @example Eager (app available at module level)
 * ```typescript
 * const harness = createHttpTestHarness(jobResource, {
 *   app,
 *   fixtures: { valid: { title: 'Test' } },
 *   auth: createJwtAuthProvider({ app, users, adminRole: 'admin' }),
 * });
 * harness.runAll();
 * ```
 *
 * @example Deferred (app from beforeAll)
 * ```typescript
 * let ctx: TestContext;
 * beforeAll(async () => { ctx = await setupTestOrg(); });
 * afterAll(async () => { await teardownTestOrg(ctx); });
 *
 * const harness = createHttpTestHarness(jobResource, () => ({
 *   app: ctx.app,
 *   apiPrefix: '',
 *   fixtures: { valid: { title: 'Test' } },
 *   auth: createBetterAuthProvider({ tokens: { admin: ctx.users.admin.token }, orgId: ctx.orgId, adminRole: 'admin' }),
 * }));
 * harness.runAll();
 * ```
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ResourceDefinition } from '../core/defineResource.js';
import { CRUD_OPERATIONS } from '../constants.js';

// ============================================================================
// Auth Provider Interface
// ============================================================================

/**
 * Abstraction for generating auth headers in tests.
 * Supports JWT, Better Auth, or any custom auth mechanism.
 */
export interface AuthProvider {
  /** Get HTTP headers for a given role key */
  getHeaders(role: string): Record<string, string>;
  /** Available role keys (e.g. ['admin', 'member', 'viewer']) */
  availableRoles: string[];
  /** Role key that has full CRUD access */
  adminRole: string;
}

// ============================================================================
// Auth Provider Factories
// ============================================================================

/**
 * Create an auth provider for JWT-based apps.
 *
 * Generates JWT tokens on the fly using the app's JWT plugin.
 *
 * @example
 * ```typescript
 * const auth = createJwtAuthProvider({
 *   app,
 *   users: {
 *     admin: { payload: { id: '1', roles: ['admin'] }, organizationId: 'org1' },
 *     viewer: { payload: { id: '2', roles: ['viewer'] } },
 *   },
 *   adminRole: 'admin',
 * });
 * ```
 */
export function createJwtAuthProvider(options: {
  app: FastifyInstance;
  users: Record<string, { payload: Record<string, unknown>; organizationId?: string }>;
  adminRole: string;
}): AuthProvider {
  const { app, users, adminRole } = options;

  return {
    getHeaders(role: string): Record<string, string> {
      const user = users[role];
      if (!user) {
        throw new Error(`createJwtAuthProvider: Unknown role '${role}'. Available: ${Object.keys(users).join(', ')}`);
      }
      const token = (app as any).jwt?.sign?.(user.payload) || 'mock-token';
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      if (user.organizationId) {
        headers['x-organization-id'] = user.organizationId;
      }
      return headers;
    },
    availableRoles: Object.keys(users),
    adminRole,
  };
}

/**
 * Create an auth provider for Better Auth apps.
 *
 * Uses pre-existing tokens (from signUp/signIn) rather than generating them.
 *
 * @example
 * ```typescript
 * const auth = createBetterAuthProvider({
 *   tokens: {
 *     admin: ctx.users.admin.token,
 *     member: ctx.users.member.token,
 *   },
 *   orgId: ctx.orgId,
 *   adminRole: 'admin',
 * });
 * ```
 */
export function createBetterAuthProvider(options: {
  tokens: Record<string, string>;
  orgId: string;
  adminRole: string;
}): AuthProvider {
  const { tokens, orgId, adminRole } = options;

  return {
    getHeaders(role: string): Record<string, string> {
      const token = tokens[role];
      if (!token) {
        throw new Error(`createBetterAuthProvider: No token for role '${role}'. Available: ${Object.keys(tokens).join(', ')}`);
      }
      return {
        authorization: `Bearer ${token}`,
        'x-organization-id': orgId,
      };
    },
    availableRoles: Object.keys(tokens),
    adminRole,
  };
}

// ============================================================================
// HTTP Test Harness
// ============================================================================

export interface HttpTestHarnessOptions<T = unknown> {
  /** Fastify app instance (must be ready) */
  app: FastifyInstance;
  /** Test data fixtures */
  fixtures: {
    /** Valid payload for creating a resource */
    valid: Partial<T>;
    /** Payload for updating a resource (defaults to valid) */
    update?: Partial<T>;
    /** Invalid payload that should fail validation */
    invalid?: Partial<T>;
  };
  /** Auth provider for generating request headers */
  auth: AuthProvider;
  /** API path prefix (default: '/api' for eager, '' for deferred) */
  apiPrefix?: string;
}

/** Options can be passed directly or as a getter for deferred resolution */
type OptionsOrGetter<T> = HttpTestHarnessOptions<T> | (() => HttpTestHarnessOptions<T>);

/**
 * HTTP-level test harness for Arc resources.
 *
 * Generates tests that exercise the full HTTP lifecycle:
 * routes, auth, permissions, pipeline, and response envelope.
 *
 * Supports deferred options via a getter function, which is essential
 * when the app instance comes from async `beforeAll()` setup.
 */
export class HttpTestHarness<T = unknown> {
  private resource: ResourceDefinition<unknown>;
  private optionsOrGetter: OptionsOrGetter<T>;
  private eagerBaseUrl: string | null;
  private enabledRoutes: Set<string>;
  private updateMethod: string;

  constructor(resource: ResourceDefinition<unknown>, optionsOrGetter: OptionsOrGetter<T>) {
    this.resource = resource;
    this.optionsOrGetter = optionsOrGetter;

    // For eager mode, compute baseUrl immediately.
    // For deferred mode, baseUrl is resolved lazily from the getter options.
    if (typeof optionsOrGetter === 'function') {
      this.eagerBaseUrl = null;
    } else {
      const apiPrefix = optionsOrGetter.apiPrefix ?? '/api';
      this.eagerBaseUrl = `${apiPrefix}${resource.prefix}`;
    }

    // Determine which CRUD routes are enabled (from resource, not options)
    const disabled = new Set(resource.disabledRoutes ?? []);
    this.enabledRoutes = new Set(
      resource.disableDefaultRoutes
        ? []
        : CRUD_OPERATIONS.filter((op) => !disabled.has(op)),
    );

    this.updateMethod = resource.updateMethod === 'PUT' ? 'PUT' : 'PATCH';
  }

  /** Resolve options (supports both direct and deferred) */
  private getOptions(): HttpTestHarnessOptions<T> {
    return typeof this.optionsOrGetter === 'function'
      ? this.optionsOrGetter()
      : this.optionsOrGetter;
  }

  /**
   * Resolve the base URL for requests.
   *
   * - Eager mode: uses pre-computed baseUrl from constructor
   * - Deferred mode: reads apiPrefix from the getter options at runtime
   *
   * Must only be called inside it()/afterAll() callbacks (after beforeAll has run).
   */
  private getBaseUrl(): string {
    if (this.eagerBaseUrl !== null) return this.eagerBaseUrl;
    const opts = this.getOptions();
    const apiPrefix = opts.apiPrefix ?? '';
    return `${apiPrefix}${this.resource.prefix}`;
  }

  /**
   * Run all test suites: CRUD + permissions + validation
   */
  runAll(): void {
    this.runCrud();
    this.runPermissions();
    this.runValidation();
  }

  /**
   * Run HTTP-level CRUD tests.
   *
   * Tests each enabled CRUD operation through app.inject():
   * - POST (create) → 200/201 with { success: true, data }
   * - GET (list) → 200 with array or paginated response
   * - GET /:id → 200 with { success: true, data }
   * - PATCH/PUT /:id → 200 with { success: true, data }
   * - DELETE /:id → 200
   * - GET /:id with non-existent ID → 404
   */
  runCrud(): void {
    const { resource, enabledRoutes, updateMethod } = this;

    // Track created IDs for cleanup and cross-test references
    let createdId: string | null = null;

    describe(`${resource.displayName} HTTP CRUD`, () => {
      afterAll(async () => {
        // Cleanup: delete the created resource if still exists
        if (createdId && enabledRoutes.has('delete')) {
          const { app, auth } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          await app.inject({
            method: 'DELETE',
            url: `${baseUrl}/${createdId}`,
            headers: auth.getHeaders(auth.adminRole),
          });
        }
      });

      if (enabledRoutes.has('create')) {
        it('POST should create a resource', async () => {
          const { app, auth, fixtures } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const adminHeaders = auth.getHeaders(auth.adminRole);

          const res = await app.inject({
            method: 'POST',
            url: baseUrl,
            headers: adminHeaders,
            payload: fixtures.valid,
          });

          expect(res.statusCode).toBeLessThan(300);
          const body = JSON.parse(res.body);
          expect(body.success).toBe(true);
          expect(body.data).toBeDefined();
          expect(body.data._id).toBeDefined();

          // Store for subsequent tests
          createdId = body.data._id;
        });
      }

      if (enabledRoutes.has('list')) {
        it('GET should list resources', async () => {
          const { app, auth } = this.getOptions();
          const baseUrl = this.getBaseUrl();

          const res = await app.inject({
            method: 'GET',
            url: baseUrl,
            headers: auth.getHeaders(auth.adminRole),
          });

          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body);
          expect(body.success).toBe(true);
          // Arc list responses use `data` or `docs` depending on the query parser
          const list = body.data ?? body.docs;
          expect(list).toBeDefined();
          expect(Array.isArray(list)).toBe(true);
        });
      }

      if (enabledRoutes.has('get')) {
        it('GET /:id should return the resource', async () => {
          if (!createdId) return;

          const { app, auth } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({
            method: 'GET',
            url: `${baseUrl}/${createdId}`,
            headers: auth.getHeaders(auth.adminRole),
          });

          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body);
          expect(body.success).toBe(true);
          expect(body.data).toBeDefined();
          expect(body.data._id).toBe(createdId);
        });

        it('GET /:id with non-existent ID should return 404', async () => {
          const { app, auth } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const fakeId = '000000000000000000000000';
          const res = await app.inject({
            method: 'GET',
            url: `${baseUrl}/${fakeId}`,
            headers: auth.getHeaders(auth.adminRole),
          });

          expect(res.statusCode).toBe(404);
          const body = JSON.parse(res.body);
          expect(body.success).toBe(false);
        });
      }

      if (enabledRoutes.has('update')) {
        it(`${updateMethod} /:id should update the resource`, async () => {
          if (!createdId) return;

          const { app, auth, fixtures } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const updatePayload = fixtures.update || fixtures.valid;
          const res = await app.inject({
            method: updateMethod as any,
            url: `${baseUrl}/${createdId}`,
            headers: auth.getHeaders(auth.adminRole),
            payload: updatePayload,
          });

          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body);
          expect(body.success).toBe(true);
          expect(body.data).toBeDefined();
        });

        it(`${updateMethod} /:id with non-existent ID should return 404`, async () => {
          const { app, auth, fixtures } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const fakeId = '000000000000000000000000';
          const res = await app.inject({
            method: updateMethod as any,
            url: `${baseUrl}/${fakeId}`,
            headers: auth.getHeaders(auth.adminRole),
            payload: fixtures.update || fixtures.valid,
          });

          expect(res.statusCode).toBe(404);
        });
      }

      if (enabledRoutes.has('delete')) {
        it('DELETE /:id should delete the resource', async () => {
          const { app, auth, fixtures } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const adminHeaders = auth.getHeaders(auth.adminRole);

          // Create a separate resource for deletion to avoid affecting other tests
          let deleteId: string | undefined;

          if (enabledRoutes.has('create')) {
            const createRes = await app.inject({
              method: 'POST',
              url: baseUrl,
              headers: adminHeaders,
              payload: fixtures.valid,
            });
            deleteId = JSON.parse(createRes.body).data?._id;
          }

          if (!deleteId) return;

          const res = await app.inject({
            method: 'DELETE',
            url: `${baseUrl}/${deleteId}`,
            headers: adminHeaders,
          });

          expect(res.statusCode).toBe(200);

          // Verify it's gone
          if (enabledRoutes.has('get')) {
            const getRes = await app.inject({
              method: 'GET',
              url: `${baseUrl}/${deleteId}`,
              headers: adminHeaders,
            });
            expect(getRes.statusCode).toBe(404);
          }
        });

        it('DELETE /:id with non-existent ID should return 404', async () => {
          const { app, auth } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const fakeId = '000000000000000000000000';
          const res = await app.inject({
            method: 'DELETE',
            url: `${baseUrl}/${fakeId}`,
            headers: auth.getHeaders(auth.adminRole),
          });

          expect(res.statusCode).toBe(404);
        });
      }
    });
  }

  /**
   * Run permission tests.
   *
   * Tests that:
   * - Unauthenticated requests return 401
   * - Admin role gets 2xx for all operations
   */
  runPermissions(): void {
    const { resource, enabledRoutes, updateMethod } = this;

    describe(`${resource.displayName} HTTP Permissions`, () => {
      if (enabledRoutes.has('list')) {
        it('GET list without auth should return 401', async () => {
          const { app } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({ method: 'GET', url: baseUrl });
          expect(res.statusCode).toBe(401);
        });
      }

      if (enabledRoutes.has('get')) {
        it('GET get without auth should return 401', async () => {
          const { app } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({ method: 'GET', url: `${baseUrl}/000000000000000000000000` });
          expect(res.statusCode).toBe(401);
        });
      }

      if (enabledRoutes.has('create')) {
        it('POST create without auth should return 401', async () => {
          const { app, fixtures } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({ method: 'POST', url: baseUrl, payload: fixtures.valid });
          expect(res.statusCode).toBe(401);
        });
      }

      if (enabledRoutes.has('update')) {
        it(`${updateMethod} update without auth should return 401`, async () => {
          const { app, fixtures } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({
            method: updateMethod as any,
            url: `${baseUrl}/000000000000000000000000`,
            payload: fixtures.update || fixtures.valid,
          });
          expect(res.statusCode).toBe(401);
        });
      }

      if (enabledRoutes.has('delete')) {
        it('DELETE delete without auth should return 401', async () => {
          const { app } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({ method: 'DELETE', url: `${baseUrl}/000000000000000000000000` });
          expect(res.statusCode).toBe(401);
        });
      }

      // Admin access tests
      if (enabledRoutes.has('list')) {
        it('admin should access list endpoint', async () => {
          const { app, auth } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({
            method: 'GET',
            url: baseUrl,
            headers: auth.getHeaders(auth.adminRole),
          });
          expect(res.statusCode).toBeLessThan(400);
        });
      }

      if (enabledRoutes.has('create')) {
        it('admin should access create endpoint', async () => {
          const { app, auth, fixtures } = this.getOptions();
          const baseUrl = this.getBaseUrl();
          const res = await app.inject({
            method: 'POST',
            url: baseUrl,
            headers: auth.getHeaders(auth.adminRole),
            payload: fixtures.valid,
          });
          expect(res.statusCode).toBeLessThan(400);

          // Cleanup
          const body = JSON.parse(res.body);
          if (body.data?._id && enabledRoutes.has('delete')) {
            await app.inject({
              method: 'DELETE',
              url: `${baseUrl}/${body.data._id}`,
              headers: auth.getHeaders(auth.adminRole),
            });
          }
        });
      }
    });
  }

  /**
   * Run validation tests.
   *
   * Tests that invalid payloads return 400.
   */
  runValidation(): void {
    const { resource, enabledRoutes } = this;

    if (!enabledRoutes.has('create')) return;

    describe(`${resource.displayName} HTTP Validation`, () => {
      it('POST with invalid payload should not return 2xx', async () => {
        const { app, auth, fixtures } = this.getOptions();
        const baseUrl = this.getBaseUrl();
        if (!fixtures.invalid) return;

        const res = await app.inject({
          method: 'POST',
          url: baseUrl,
          headers: auth.getHeaders(auth.adminRole),
          payload: fixtures.invalid,
        });

        // Invalid payload should be rejected — 400 (schema validation) or
        // 422/500 (model validation) depending on whether JSON Schema is configured
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(false);
      });
    });
  }
}

/**
 * Create an HTTP test harness for an Arc resource.
 *
 * Accepts options directly or as a getter function for deferred resolution.
 *
 * @example Deferred (recommended for async setup)
 * ```typescript
 * let ctx: TestContext;
 * beforeAll(async () => { ctx = await setupTestOrg(); });
 *
 * createHttpTestHarness(jobResource, () => ({
 *   app: ctx.app,
 *   apiPrefix: '',
 *   fixtures: { valid: { title: 'Test' } },
 *   auth: createBetterAuthProvider({ ... }),
 * })).runAll();
 * ```
 */
export function createHttpTestHarness<T = unknown>(
  resource: ResourceDefinition<unknown>,
  optionsOrGetter: HttpTestHarnessOptions<T> | (() => HttpTestHarnessOptions<T>),
): HttpTestHarness<T> {
  return new HttpTestHarness<T>(resource, optionsOrGetter);
}
