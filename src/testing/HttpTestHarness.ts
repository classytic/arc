/**
 * HttpTestHarness — auto-generate HTTP-level CRUD/permission/validation tests
 *
 * Exercises the full request lifecycle via `app.inject()` — routes, auth,
 * permissions, pipeline, field permissions, action endpoints (since v2.11
 * action routes share the preHandler chain with CRUD), and the arc response
 * envelope. Not a replacement for targeted tests, but it covers the
 * repetitive baseline every resource needs for free.
 *
 * Auth is provided by a `TestAuthProvider` (see `authSession.ts`) — a single
 * abstraction replaces the old `createJwtAuthProvider` / `createBetterAuthProvider`
 * call pair. The harness reads role-based headers via `auth.as(role).headers`.
 *
 * @example
 * ```typescript
 * import { describe, beforeAll, afterAll } from 'vitest';
 * import { createTestApp, createHttpTestHarness, expectArc } from '@classytic/arc/testing';
 *
 * let ctx;
 * beforeAll(async () => {
 *   ctx = await createTestApp({ resources: [jobResource], authMode: 'jwt' });
 *   ctx.auth.register('admin', { user: { id: '1', roles: ['admin'] } });
 * });
 * afterAll(() => ctx.close());
 *
 * createHttpTestHarness(jobResource, () => ({
 *   app: ctx.app,
 *   auth: ctx.auth,
 *   adminRole: 'admin',
 *   fixtures: { valid: { title: 'Test' }, invalid: {} },
 * })).runAll();
 * ```
 */

import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { CRUD_OPERATIONS } from "../constants.js";
import type { ResourceDefinition } from "../core/defineResource.js";
import type { PermissionCheck } from "../permissions/types.js";
import type { TestAuthProvider } from "./authSession.js";

type CrudOp = "list" | "get" | "create" | "update" | "delete";
type UpdateVerb = "PATCH" | "PUT";

/**
 * An op is "protected" (should 401 without a token) unless the resource
 * explicitly wired `allowPublic()` — that's the same rule arc's router uses
 * via `requiresAuthentication`. Treats absent permission as public (matches
 * the router's behaviour for historical reasons); the harness only emits the
 * unauthenticated 401 assertion when the op is actually protected.
 */
function opRequiresAuth(resource: ResourceDefinition<unknown>, op: CrudOp): boolean {
  const permissions = resource.permissions as
    | Record<string, PermissionCheck | undefined>
    | undefined;
  const check = permissions?.[op];
  if (!check) return false;
  return check._isPublic !== true;
}

// ============================================================================
// Options
// ============================================================================

export interface HttpTestHarnessOptions<T = unknown> {
  /** Fastify app (must be ready). */
  app: FastifyInstance;
  /** Auth provider (from `createTestApp` or one of the auth factories). */
  auth: TestAuthProvider;
  /** Role name registered on `auth` that has full CRUD access. */
  adminRole: string;
  /** Request bodies for CRUD probes. */
  fixtures: {
    valid: Partial<T>;
    update?: Partial<T>;
    invalid?: Partial<T>;
  };
  /** URL prefix (default: `""`; apps mounted under `/api` pass `/api`). */
  apiPrefix?: string;
}

type OptionsOrGetter<T> = HttpTestHarnessOptions<T> | (() => HttpTestHarnessOptions<T>);

// ============================================================================
// Harness
// ============================================================================

export class HttpTestHarness<T = unknown> {
  private resource: ResourceDefinition<unknown>;
  private optionsOrGetter: OptionsOrGetter<T>;
  private enabledRoutes: Set<(typeof CRUD_OPERATIONS)[number]>;
  private updateMethods: readonly ("PATCH" | "PUT")[];

  constructor(resource: ResourceDefinition<unknown>, optionsOrGetter: OptionsOrGetter<T>) {
    this.resource = resource;
    this.optionsOrGetter = optionsOrGetter;

    const disabled = new Set(resource.disabledRoutes ?? []);
    this.enabledRoutes = new Set(
      resource.disableDefaultRoutes ? [] : CRUD_OPERATIONS.filter((op) => !disabled.has(op)),
    );

    const um = resource.updateMethod;
    this.updateMethods =
      um === "both"
        ? (["PATCH", "PUT"] as const)
        : um === "PUT"
          ? (["PUT"] as const)
          : (["PATCH"] as const);
  }

  private getOptions(): HttpTestHarnessOptions<T> {
    return typeof this.optionsOrGetter === "function"
      ? this.optionsOrGetter()
      : this.optionsOrGetter;
  }

  private getBaseUrl(): string {
    const opts = this.getOptions();
    const apiPrefix = opts.apiPrefix ?? "";
    return `${apiPrefix}${this.resource.prefix}`;
  }

  private adminHeaders(): Record<string, string> {
    const opts = this.getOptions();
    return { ...opts.auth.as(opts.adminRole).headers };
  }

  runAll(): void {
    this.runCrud();
    this.runPermissions();
    this.runValidation();
  }

  runCrud(): void {
    const { resource, enabledRoutes, updateMethods } = this;
    let createdId: string | null = null;

    describe(`${resource.displayName} HTTP CRUD`, () => {
      afterAll(async () => {
        if (createdId && enabledRoutes.has("delete")) {
          const { app } = this.getOptions();
          await app.inject({
            method: "DELETE",
            url: `${this.getBaseUrl()}/${createdId}`,
            headers: this.adminHeaders(),
          });
        }
      });

      if (enabledRoutes.has("create")) {
        it("POST should create a resource", async () => {
          const { app, fixtures } = this.getOptions();
          const res = await app.inject({
            method: "POST",
            url: this.getBaseUrl(),
            headers: this.adminHeaders(),
            payload: fixtures.valid as Record<string, unknown>,
          });
          expect(res.statusCode).toBeLessThan(300);
          const body = JSON.parse(res.body);
          expect(body.success).toBe(true);
          expect(body.data?._id).toBeDefined();
          createdId = body.data._id;
        });
      }

      if (enabledRoutes.has("list")) {
        it("GET should list resources", async () => {
          const { app } = this.getOptions();
          const res = await app.inject({
            method: "GET",
            url: this.getBaseUrl(),
            headers: this.adminHeaders(),
          });
          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body);
          expect(body.success).toBe(true);
          const list = body.data ?? body.data;
          expect(Array.isArray(list)).toBe(true);
        });
      }

      if (enabledRoutes.has("get")) {
        it("GET /:id should return the resource", async () => {
          if (!createdId) return;
          const { app } = this.getOptions();
          const res = await app.inject({
            method: "GET",
            url: `${this.getBaseUrl()}/${createdId}`,
            headers: this.adminHeaders(),
          });
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body).data?._id).toBe(createdId);
        });

        it("GET /:id with non-existent ID should return 404", async () => {
          const { app } = this.getOptions();
          const res = await app.inject({
            method: "GET",
            url: `${this.getBaseUrl()}/000000000000000000000000`,
            headers: this.adminHeaders(),
          });
          expect(res.statusCode).toBe(404);
          expect(JSON.parse(res.body).success).toBe(false);
        });
      }

      if (enabledRoutes.has("update")) {
        // When `updateMethod: "both"` is set on the resource, arc mounts BOTH
        // PUT and PATCH — iterate both here so neither verb is silently
        // skipped. Single-method resources fall through with one iteration.
        for (const verb of updateMethods) {
          it(`${verb} /:id should update the resource`, async () => {
            if (!createdId) return;
            const { app, fixtures } = this.getOptions();
            const payload = (fixtures.update ?? fixtures.valid) as Record<string, unknown>;
            const res = await app.inject({
              method: verb,
              url: `${this.getBaseUrl()}/${createdId}`,
              headers: this.adminHeaders(),
              payload,
            });
            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.body).success).toBe(true);
          });

          it(`${verb} /:id with non-existent ID should return 404`, async () => {
            const { app, fixtures } = this.getOptions();
            const payload = (fixtures.update ?? fixtures.valid) as Record<string, unknown>;
            const res = await app.inject({
              method: verb,
              url: `${this.getBaseUrl()}/000000000000000000000000`,
              headers: this.adminHeaders(),
              payload,
            });
            expect(res.statusCode).toBe(404);
          });
        }
      }

      if (enabledRoutes.has("delete")) {
        it("DELETE /:id should delete the resource", async () => {
          const { app, fixtures } = this.getOptions();
          let deleteId: string | undefined;
          if (enabledRoutes.has("create")) {
            const createRes = await app.inject({
              method: "POST",
              url: this.getBaseUrl(),
              headers: this.adminHeaders(),
              payload: fixtures.valid as Record<string, unknown>,
            });
            deleteId = JSON.parse(createRes.body).data?._id;
          }
          if (!deleteId) return;

          const res = await app.inject({
            method: "DELETE",
            url: `${this.getBaseUrl()}/${deleteId}`,
            headers: this.adminHeaders(),
          });
          expect(res.statusCode).toBe(200);

          if (enabledRoutes.has("get")) {
            const getRes = await app.inject({
              method: "GET",
              url: `${this.getBaseUrl()}/${deleteId}`,
              headers: this.adminHeaders(),
            });
            expect(getRes.statusCode).toBe(404);
          }
        });

        it("DELETE /:id with non-existent ID should return 404", async () => {
          const { app } = this.getOptions();
          const res = await app.inject({
            method: "DELETE",
            url: `${this.getBaseUrl()}/000000000000000000000000`,
            headers: this.adminHeaders(),
          });
          expect(res.statusCode).toBe(404);
        });
      }
    });
  }

  runPermissions(): void {
    const { resource, enabledRoutes, updateMethods } = this;

    // Only emit the unauthenticated-401 assertion for ops that are actually
    // protected (i.e. have a permission check and it's not `allowPublic`).
    // Resources with `allowPublic()` on an op would otherwise produce false
    // failures here.
    const protectedOps = {
      list: opRequiresAuth(resource, "list"),
      get: opRequiresAuth(resource, "get"),
      create: opRequiresAuth(resource, "create"),
      update: opRequiresAuth(resource, "update"),
      delete: opRequiresAuth(resource, "delete"),
    };

    describe(`${resource.displayName} HTTP Permissions`, () => {
      // Unauthenticated — only emitted for protected ops
      if (enabledRoutes.has("list") && protectedOps.list) {
        it("GET list without auth should return 401", async () => {
          const { app } = this.getOptions();
          const res = await app.inject({ method: "GET", url: this.getBaseUrl() });
          expect(res.statusCode).toBe(401);
        });
      }
      if (enabledRoutes.has("get") && protectedOps.get) {
        it("GET /:id without auth should return 401", async () => {
          const { app } = this.getOptions();
          const res = await app.inject({
            method: "GET",
            url: `${this.getBaseUrl()}/000000000000000000000000`,
          });
          expect(res.statusCode).toBe(401);
        });
      }
      if (enabledRoutes.has("create") && protectedOps.create) {
        it("POST without auth should return 401", async () => {
          const { app, fixtures } = this.getOptions();
          const res = await app.inject({
            method: "POST",
            url: this.getBaseUrl(),
            payload: fixtures.valid as Record<string, unknown>,
          });
          expect(res.statusCode).toBe(401);
        });
      }
      if (enabledRoutes.has("update") && protectedOps.update) {
        for (const verb of updateMethods) {
          it(`${verb} without auth should return 401`, async () => {
            const { app, fixtures } = this.getOptions();
            const payload = (fixtures.update ?? fixtures.valid) as Record<string, unknown>;
            const res = await app.inject({
              method: verb,
              url: `${this.getBaseUrl()}/000000000000000000000000`,
              payload,
            });
            expect(res.statusCode).toBe(401);
          });
        }
      }
      if (enabledRoutes.has("delete") && protectedOps.delete) {
        it("DELETE without auth should return 401", async () => {
          const { app } = this.getOptions();
          const res = await app.inject({
            method: "DELETE",
            url: `${this.getBaseUrl()}/000000000000000000000000`,
          });
          expect(res.statusCode).toBe(401);
        });
      }

      // Admin access — every enabled op should succeed (public ops too, via admin headers).
      if (enabledRoutes.has("list")) {
        it("admin should access list endpoint", async () => {
          const { app } = this.getOptions();
          const res = await app.inject({
            method: "GET",
            url: this.getBaseUrl(),
            headers: this.adminHeaders(),
          });
          expect(res.statusCode).toBeLessThan(400);
        });
      }
      if (enabledRoutes.has("create")) {
        it("admin should access create endpoint", async () => {
          const { app, fixtures } = this.getOptions();
          const res = await app.inject({
            method: "POST",
            url: this.getBaseUrl(),
            headers: this.adminHeaders(),
            payload: fixtures.valid as Record<string, unknown>,
          });
          expect(res.statusCode).toBeLessThan(400);
          const body = JSON.parse(res.body);
          if (body.data?._id && enabledRoutes.has("delete")) {
            await app.inject({
              method: "DELETE",
              url: `${this.getBaseUrl()}/${body.data._id}`,
              headers: this.adminHeaders(),
            });
          }
        });
      }
    });
  }

  runValidation(): void {
    const { resource, enabledRoutes } = this;
    if (!enabledRoutes.has("create")) return;

    describe(`${resource.displayName} HTTP Validation`, () => {
      it("POST with invalid payload should be rejected", async () => {
        const { app, fixtures } = this.getOptions();
        if (!fixtures.invalid) return;
        const res = await app.inject({
          method: "POST",
          url: this.getBaseUrl(),
          headers: this.adminHeaders(),
          payload: fixtures.invalid as Record<string, unknown>,
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(JSON.parse(res.body).success).toBe(false);
      });
    });
  }
}

/**
 * Create an HTTP test harness. `optionsOrGetter` may be a plain object
 * (for eager app setup) or a getter function (for async `beforeAll` apps).
 */
export function createHttpTestHarness<T = unknown>(
  resource: ResourceDefinition<unknown>,
  optionsOrGetter: HttpTestHarnessOptions<T> | (() => HttpTestHarnessOptions<T>),
): HttpTestHarness<T> {
  return new HttpTestHarness<T>(resource, optionsOrGetter);
}
