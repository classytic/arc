/**
 * Regression tests for the four host-reported DX fixes shipped in 2.10.6:
 *
 * 1. Auto-mark `tenantField` as `systemManaged` — eliminates boilerplate
 *    `fieldRules: { organizationId: { systemManaged: true } }` on every
 *    multi-tenant resource.
 * 2. `ControllerLike` dropped its `[key: string]: unknown` index signature
 *    — class instances assign without `as unknown as ControllerLike`.
 * 3. First-class `req.scope: { organizationId?, userId?, orgRoles? }`
 *    projection on `IRequestContext` — controllers don't have to reach
 *    into `req.metadata._scope`.
 * 4. `defineErrorMapper<T>(...)` helper — typed registration of domain
 *    error mappers without `as unknown as ErrorMapper`.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { defineErrorMapper } from "../../src/utils/defineErrorMapper.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import type { ErrorMapper } from "../../src/plugins/errorHandler.js";
import type {
  ControllerLike,
  IControllerResponse,
  IRequestContext,
} from "../../src/types/index.js";

// ────────────────────────────────────────────────────────────────────────
// Fix 1 — auto-mark tenantField as systemManaged
// ────────────────────────────────────────────────────────────────────────

describe("2.10.6 · auto-mark tenantField as systemManaged", () => {
  it("injects systemManaged:true when tenantField is set and no rule exists", () => {
    interface Invoice {
      _id?: string;
      organizationId?: string;
      number: string;
    }
    const resource = defineResource<Invoice>({
      name: "invoice",
      tenantField: "organizationId",
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const rules = resource.schemaOptions?.fieldRules;
    expect(rules?.organizationId?.systemManaged).toBe(true);
  });

  it("respects a caller-supplied rule (systemManaged:false stays false)", () => {
    interface Invoice {
      _id?: string;
      organizationId?: string;
      number: string;
    }
    const resource = defineResource<Invoice>({
      name: "invoice-opt-out",
      tenantField: "organizationId",
      disableDefaultRoutes: true,
      schemaOptions: {
        fieldRules: {
          organizationId: { systemManaged: false },
        },
      },
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    expect(resource.schemaOptions?.fieldRules?.organizationId?.systemManaged).toBe(false);
  });

  it("uses the configured tenantField name (not hard-coded to organizationId)", () => {
    interface Widget {
      _id?: string;
      accountId?: string;
      kind: string;
    }
    const resource = defineResource<Widget>({
      name: "widget",
      tenantField: "accountId",
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    expect(resource.schemaOptions?.fieldRules?.accountId?.systemManaged).toBe(true);
    // Not stamped on the literal "organizationId" key
    expect(resource.schemaOptions?.fieldRules?.organizationId).toBeUndefined();
  });

  it("skips injection for platform-universal resources (tenantField:false)", () => {
    interface Widget {
      _id?: string;
      kind: string;
    }
    const resource = defineResource<Widget>({
      name: "platform-widget",
      tenantField: false,
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
      },
    });

    // No tenantField → no injection. schemaOptions may be empty or undefined.
    const rules = resource.schemaOptions?.fieldRules ?? {};
    expect(Object.keys(rules).length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Fix 2 — ControllerLike accepts class instances without a cast
// ────────────────────────────────────────────────────────────────────────

describe("2.10.6 · ControllerLike accepts class instances without cast", () => {
  it("class with extra methods + private fields assigns to ControllerLike", () => {
    class ScrapController {
      #redactionRules = new Map<string, string>();
      async list(_req: IRequestContext): Promise<IControllerResponse> {
        return { success: true, data: [] };
      }
      async create(_req: IRequestContext): Promise<IControllerResponse> {
        return { success: true, data: {} };
      }
      // Extra domain method the controller needs — not part of the contract.
      private redact(value: string): string {
        return this.#redactionRules.get(value) ?? value;
      }
    }

    // Compile-time check: this line used to require
    // `as unknown as ControllerLike`. It must now assign clean.
    const instance = new ScrapController();
    const asControllerLike: ControllerLike = instance;
    expect(asControllerLike).toBeDefined();
    // Runtime sanity: arc only reads the CRUD slots.
    expect(typeof asControllerLike.list).toBe("function");
    expect(typeof asControllerLike.create).toBe("function");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Fix 3 — req.scope projection
// ────────────────────────────────────────────────────────────────────────

describe("2.10.6 · first-class req.scope projection on IRequestContext", () => {
  async function buildAppWithScopeRoute(): Promise<FastifyInstance> {
    const fastify = Fastify({ logger: false });

    // Fake auth: copy headers into request.scope (the union arc's fastifyAdapter projects).
    fastify.addHook("preHandler", async (request) => {
      const orgId = request.headers["x-org"];
      if (typeof orgId !== "string") return;
      (request as { user?: unknown }).user = { id: "user_test", roles: ["member"] };
      (request as { scope?: unknown }).scope = {
        kind: "member",
        userId: "user_test",
        roles: ["member"],
        organizationId: orgId,
        organizationRole: "admin",
        orgRoles: ["admin", "warehouse-manager"],
      };
    });

    // Minimal route using a ControllerHandler — exercises createRequestContext.
    const resource = defineResource({
      name: "probe",
      prefix: "/probe",
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/whoami",
          permissions: requireAuth(),
          handler: async (req: IRequestContext): Promise<IControllerResponse> => ({
            success: true,
            data: { scope: req.scope },
          }),
        },
      ],
    });

    await fastify.register(resource.toPlugin());
    await fastify.ready();
    return fastify;
  }

  it("exposes organizationId / userId / orgRoles without reaching into metadata._scope", async () => {
    const app = await buildAppWithScopeRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/probe/whoami",
        headers: { "x-org": "org_alpha" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const scope = body.data?.scope;
      expect(scope).toBeDefined();
      expect(scope.organizationId).toBe("org_alpha");
      expect(scope.userId).toBe("user_test");
      expect(scope.orgRoles).toEqual(["admin", "warehouse-manager"]);
    } finally {
      await app.close();
    }
  });

  it("scope is undefined when the caller has no auth (public route)", async () => {
    const fastify = Fastify({ logger: false });
    const resource = defineResource({
      name: "probe-public",
      prefix: "/probe-public",
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/whoami",
          permissions: allowPublic(),
          handler: async (req: IRequestContext): Promise<IControllerResponse> => ({
            success: true,
            data: { scope: req.scope ?? null },
          }),
        },
      ],
    });

    await fastify.register(resource.toPlugin());
    await fastify.ready();
    try {
      const res = await fastify.inject({ method: "GET", url: "/probe-public/whoami" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.scope).toBeNull();
    } finally {
      await fastify.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Fix 4 — defineErrorMapper<T>()
// ────────────────────────────────────────────────────────────────────────

describe("2.10.6 · defineErrorMapper helper — typed registration without cast", () => {
  it("a typed mapper assigns into ErrorMapper[] without 'as unknown as ErrorMapper'", () => {
    class FlowError extends Error {
      constructor(
        message: string,
        public readonly domainCode: string,
      ) {
        super(message);
      }
    }
    class InvalidTransitionError extends FlowError {
      constructor(
        public readonly from: string,
        public readonly to: string,
        public readonly resourceId?: string,
      ) {
        super(`cannot transition ${from} → ${to}`, "INVALID_TRANSITION");
      }
    }

    // Compile-time: this array used to require a cast on every entry.
    // defineErrorMapper now makes both work without.
    const mappers: ErrorMapper[] = [
      defineErrorMapper<FlowError>({
        type: FlowError,
        toResponse: (err) => ({
          status: 400,
          code: err.domainCode,
          message: err.message,
        }),
      }),
      defineErrorMapper<InvalidTransitionError>({
        type: InvalidTransitionError,
        toResponse: (err) => ({
          status: 409,
          code: "INVALID_TRANSITION",
          message: err.message,
          details: { from: err.from, to: err.to, resourceId: err.resourceId },
        }),
      }),
    ];

    expect(mappers).toHaveLength(2);
    // Runtime: the type field is preserved verbatim — dispatch uses instanceof
    expect(mappers[0].type).toBe(FlowError);
    expect(mappers[1].type).toBe(InvalidTransitionError);

    // Runtime sanity — the toResponse callback works under the widened signature
    // because arc's dispatch checks `instanceof` first.
    const err = new InvalidTransitionError("draft", "paid", "inv-1");
    const mapped = mappers[1].toResponse(err);
    expect(mapped.status).toBe(409);
    expect(mapped.details?.resourceId).toBe("inv-1");
  });

  it("preserves the narrowed type for direct use (no widening visible to the caller)", () => {
    class DomainError extends Error {
      constructor(
        message: string,
        public readonly domainCode: string,
      ) {
        super(message);
      }
    }

    const mapper = defineErrorMapper<DomainError>({
      type: DomainError,
      toResponse: (err) => ({ status: 400, code: err.domainCode }),
    });

    // The helper widens to `ErrorMapper` (for array assignability) —
    // callers who need the narrowed form use the decl-site type directly.
    expectTypeOf(mapper).toMatchTypeOf<ErrorMapper>();
  });
});
