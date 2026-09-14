/**
 * `crossTenant` — reads that are not scoped to a tenant at all.
 *
 * THE BUG THIS EXISTS FOR. `allowPublic` answers "may an anonymous caller reach this route?", and
 * a resource serving a marketplace listing needs the answer to a different question: "is this
 * listing scoped to a tenant?". Until `crossTenant` there was no way to say no. An `allowPublic`
 * route still filters by the caller's organization whenever they have one, and a signed-in user of
 * a multi-org product always has one, because choosing an organization writes it onto the session.
 * So a public catalog became single-tenant the moment one of its own sellers browsed it: same URL,
 * no header and no query parameter to explain it, a different world depending on who asked.
 *
 * The assertions below are deliberately about the RESULTING FILTER rather than about how many
 * middlewares a slot holds. A structural test ("the list slot is empty") passes for a preset that
 * silently stopped filtering everything, which is the failure it is supposed to catch. Every test
 * here therefore drives a real request through the middleware and inspects `_policyFilters`, and
 * the control cases matter as much as the new ones: writes, and unlisted reads, must be untouched.
 */

import { describe, expect, it, vi } from "vitest";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import type { RequestScope } from "../../src/scope/types.js";
import type { RequestWithExtras, RouteHandler } from "../../src/types/index.js";

function makeRequest(scope: RequestScope, body?: Record<string, unknown>): RequestWithExtras {
  return { scope, body, _policyFilters: undefined } as unknown as RequestWithExtras;
}

function makeReply(): {
  reply: { code: (n: number) => unknown; send: (p: unknown) => unknown };
  status: { code?: number; payload?: unknown };
} {
  const status: { code?: number; payload?: unknown } = {};
  const reply = {
    code: vi.fn((n: number) => {
      status.code = n;
      return reply;
    }),
    send: vi.fn((p: unknown) => {
      status.payload = p;
      return reply;
    }),
  };
  return { reply, status };
}

async function run(
  middleware: RouteHandler,
  request: RequestWithExtras,
  reply: ReturnType<typeof makeReply>["reply"],
): Promise<void> {
  await (middleware as unknown as (req: unknown, rep: unknown) => Promise<void>)(request, reply);
}

/** A seller browsing the marketplace: authenticated, and bound to their own shop. */
const MEMBER: RequestScope = {
  kind: "member",
  userId: "u-1",
  userRoles: ["user"],
  organizationId: "org-acme",
  orgRoles: ["owner"],
};

describe("multiTenantPreset — crossTenant reads", () => {
  const marketplace = multiTenantPreset({
    tenantField: "organizationId",
    allowPublic: ["list", "get"],
    crossTenant: ["list", "get"],
  });

  /** The same resource WITHOUT the new option: what every caller had before. */
  const scoped = multiTenantPreset({
    tenantField: "organizationId",
    allowPublic: ["list", "get"],
  });

  it("THE BUG: without crossTenant, a signed-in member's list is pinned to their own org", async () => {
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    await run(scoped.middlewares?.list?.[0] as RouteHandler, request, reply);

    // This is the behaviour that turned a marketplace into one seller's shelf.
    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });

  it("with crossTenant, the same member's list carries no tenant filter", async () => {
    const list = marketplace.middlewares?.list ?? [];
    const request = makeRequest(MEMBER);
    const { reply, status } = makeReply();
    for (const mw of list) await run(mw as RouteHandler, request, reply);

    expect(request._policyFilters).toBeUndefined();
    // Not filtered is not the same as rejected: the read must still go through.
    expect(status.code).toBeUndefined();
  });

  it("stashes no tenant fields, so the repository layer is unscoped too", async () => {
    // `_tenantFields` is what `tenantRepoOptions` forwards to plugin-scoped repos. Clearing the
    // policy filter while still stashing the org would re-scope the query one layer down, where
    // nothing in the route would show it.
    const list = marketplace.middlewares?.list ?? [];
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    for (const mw of list) await run(mw as RouteHandler, request, reply);

    expect((request as { _tenantFields?: unknown })._tenantFields).toBeUndefined();
  });

  /**
   * THE PART THAT MADE THIS LOOK UNFIXABLE.
   *
   * Four layers scope a read, and three of them re-derive the organization from the scope on their
   * own. Disabling only the preset's filter changed nothing observable, because the resolver put
   * the filter straight back one layer down. These assert the decision actually travels.
   */
  it("marks the request so the layers below the route honour the same decision", async () => {
    const list = marketplace.middlewares?.list ?? [];
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    for (const mw of list) await run(mw as RouteHandler, request, reply);

    expect((request as { _crossTenantRead?: boolean })._crossTenantRead).toBe(true);
  });

  it("CONTROL: a scoped read is not marked", async () => {
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    for (const mw of scoped.middlewares?.list ?? []) await run(mw as RouteHandler, request, reply);

    expect((request as { _crossTenantRead?: boolean })._crossTenantRead).toBeUndefined();
  });

  it("an anonymous caller is unfiltered too, and still allowed through", async () => {
    const list = marketplace.middlewares?.list ?? [];
    const request = makeRequest({ kind: "public" });
    const { reply, status } = makeReply();
    for (const mw of list) await run(mw as RouteHandler, request, reply);

    expect(request._policyFilters).toBeUndefined();
    expect(status.code).toBeUndefined();
  });

  it("applies to `get` when listed, so a detail page matches its listing", async () => {
    const get = marketplace.middlewares?.get ?? [];
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    for (const mw of get) await run(mw as RouteHandler, request, reply);

    expect(request._policyFilters).toBeUndefined();
  });

  // ── Controls: everything NOT listed must be exactly as before ──────────

  it("CONTROL: create still injects the caller's org", async () => {
    const create = marketplace.middlewares?.create ?? [];
    const body: Record<string, unknown> = { name: "A product" };
    const request = makeRequest(MEMBER, body);
    const { reply } = makeReply();
    for (const mw of create) await run(mw as RouteHandler, request, reply);

    // The guarantee that stops a member filing a document into someone else's shop.
    expect((request.body as Record<string, unknown>).organizationId).toBe("org-acme");
  });

  it("CONTROL: update still filters AND injects", async () => {
    const update = marketplace.middlewares?.update ?? [];
    expect(update.length).toBeGreaterThan(0);
    const body: Record<string, unknown> = { name: "Renamed", organizationId: "org-someone-else" };
    const request = makeRequest(MEMBER, body);
    const { reply } = makeReply();
    for (const mw of update) await run(mw as RouteHandler, request, reply);

    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
    // Injection overwrites the spoofed value rather than trusting the body.
    expect((request.body as Record<string, unknown>).organizationId).toBe("org-acme");
  });

  it("CONTROL: delete still filters", async () => {
    const del = marketplace.middlewares?.delete ?? [];
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    for (const mw of del) await run(mw as RouteHandler, request, reply);

    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });

  it("CONTROL: listing only `list` leaves `get` scoped", async () => {
    const listOnly = multiTenantPreset({
      tenantField: "organizationId",
      allowPublic: ["list", "get"],
      crossTenant: ["list"],
    });
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    for (const mw of listOnly.middlewares?.get ?? []) await run(mw as RouteHandler, request, reply);

    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });

  it("CONTROL: omitting crossTenant changes nothing at all", async () => {
    const request = makeRequest(MEMBER);
    const { reply } = makeReply();
    const plain = multiTenantPreset({ tenantField: "organizationId" });
    for (const mw of plain.middlewares?.list ?? []) await run(mw as RouteHandler, request, reply);

    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });
});
