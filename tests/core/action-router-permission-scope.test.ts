/**
 * Regression: action routes must honor PermissionResult.scope and filters.
 *
 * Before the fix, createActionRouter only inspected `granted` + `reason` from
 * PermissionResult — it silently dropped `filters` and `scope`, which meant:
 *   - Custom-auth action handlers saw `request.scope === undefined`
 *   - Ownership-style filters never reached the handler
 *
 * Now the action router funnels through `applyPermissionResult`, the same
 * helper used by createCrudRouter. This test pins that contract forever.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActionRouter } from "../../src/core/createActionRouter.js";
import type { PermissionCheck } from "../../src/permissions/types.js";
import type { RequestScope } from "../../src/scope/types.js";

// Probe: a handler that records what request.scope and _policyFilters look
// like at invocation time. Assertions then verify the permission result
// propagated through correctly.
function makeProbe() {
  const seen: {
    scope?: RequestScope;
    policyFilters?: Record<string, unknown>;
    userId?: string;
  } = {};
  return {
    seen,
    handler: async (id: string, data: Record<string, unknown>, req: FastifyRequest) => {
      const r = req as FastifyRequest & {
        scope?: RequestScope;
        _policyFilters?: Record<string, unknown>;
        user?: { id?: string };
      };
      seen.scope = r.scope;
      seen.policyFilters = r._policyFilters;
      seen.userId = r.user?.id;
      return { id, data, ok: true };
    },
  };
}

// Permission check that grants + installs a service scope + adds filters.
// Mirrors the documented `requireApiKey()` pattern from the multi-tenancy playbook.
function requireApiKey(clientId: string, organizationId: string): PermissionCheck {
  return async ({ request }) => {
    const key = request.headers["x-api-key"];
    if (key !== "valid") return { granted: false, reason: "Invalid API key" };
    return {
      granted: true,
      scope: {
        kind: "service",
        clientId,
        organizationId,
        scopes: ["jobs:write"],
      },
      filters: { projectId: "proj-1" },
    };
  };
}

describe("createActionRouter — PermissionResult scope + filters wiring", () => {
  let app: FastifyInstance;
  let probe: ReturnType<typeof makeProbe>;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    probe = makeProbe();
    createActionRouter(app, {
      tag: "Job",
      actions: { run: probe.handler },
      actionPermissions: {
        run: requireApiKey("client-xyz", "org-acme"),
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("installs service scope on request before the handler runs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/job-1/action",
      headers: { "x-api-key": "valid" },
      payload: { action: "run" },
    });

    expect(res.statusCode).toBe(200);
    expect(probe.seen.scope).toBeDefined();
    expect(probe.seen.scope?.kind).toBe("service");
    if (probe.seen.scope?.kind === "service") {
      expect(probe.seen.scope.clientId).toBe("client-xyz");
      expect(probe.seen.scope.organizationId).toBe("org-acme");
      expect(probe.seen.scope.scopes).toEqual(["jobs:write"]);
    }
  });

  it("merges permission filters into request._policyFilters", async () => {
    await app.inject({
      method: "POST",
      url: "/job-1/action",
      headers: { "x-api-key": "valid" },
      payload: { action: "run" },
    });

    expect(probe.seen.policyFilters).toEqual({ projectId: "proj-1" });
  });

  it("rejects missing API key with 401 and never invokes the handler", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/job-1/action",
      payload: { action: "run" },
    });

    expect(res.statusCode).toBe(401);
    expect(probe.seen.scope).toBeUndefined();
    expect(probe.seen.policyFilters).toBeUndefined();
  });

  it("rejects invalid API key with permission reason in body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/job-1/action",
      headers: { "x-api-key": "wrong" },
      payload: { action: "run" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Invalid API key");
  });
});
