/**
 * requireGrant — per-record grant gate (2.22)
 *
 * The record-sharing combinator from designs/record-sharing.md: arc ships
 * the GATE + mode lattice only; grant storage is a host resource and the
 * `resolve` callback is structural. Contracts under test:
 *
 *   1. Lattice: see < list < read < write < manage; held ≥ required.
 *   2. Fail-closed: resolver throws, empty resolutions, and corrupted
 *      mode strings all DENY.
 *   3. List-shaped resolutions return `filters` that flow through the
 *      permission machinery into the actual repository query (the
 *      anti-Puter property: one permission-correct query, no per-item
 *      ACL walks).
 *   4. Anonymous callers are the RESOLVER's decision (share links), not
 *      an up-front rejection.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { GRANT_MODES, modeSatisfies, requireGrant } from "../../src/permissions/grants.js";
import type { PermissionContext } from "../../src/permissions/types.js";

function ctx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    user: { id: "u1", role: ["user"] },
    request: { log: { warn: () => {} } } as unknown as FastifyRequest,
    resource: "document",
    action: "get",
    resourceId: "doc-1",
    ...overrides,
  } as PermissionContext;
}

describe("modeSatisfies — the lattice", () => {
  it("held ≥ required along see < list < read < write < manage", () => {
    expect(modeSatisfies("write", "read")).toBe(true);
    expect(modeSatisfies("manage", "see")).toBe(true);
    expect(modeSatisfies("read", "read")).toBe(true);
    expect(modeSatisfies("see", "read")).toBe(false);
    expect(modeSatisfies("list", "write")).toBe(false);
  });

  it("unknown/corrupted mode strings never satisfy anything (fail-closed)", () => {
    expect(modeSatisfies("admin", "see")).toBe(false);
    expect(modeSatisfies("", "see")).toBe(false);
    expect(modeSatisfies(undefined, "see")).toBe(false);
  });

  it("lattice order is pinned", () => {
    expect(GRANT_MODES).toEqual(["see", "list", "read", "write", "manage"]);
  });
});

describe("requireGrant — resolution contract", () => {
  it("boolean resolution passes through", async () => {
    expect(await requireGrant({ mode: "read", resolve: () => true })(ctx())).toBe(true);
    expect(await requireGrant({ mode: "read", resolve: () => false })(ctx())).toBe(false);
  });

  it("mode resolution applies the lattice", async () => {
    const granted = await requireGrant({
      mode: "read",
      resolve: () => ({ mode: "write" }),
    })(ctx());
    expect(granted).toEqual({ granted: true });

    const denied = await requireGrant({
      mode: "write",
      resolve: () => ({ mode: "read", reason: "read-only share" }),
    })(ctx());
    expect(denied).toEqual({ granted: false, reason: "read-only share" });
  });

  it("filters ride along when the mode gate passes", async () => {
    const result = await requireGrant({
      mode: "list",
      resolve: () => ({ mode: "read", filters: { orgId: "o1" } }),
    })(ctx({ action: "list" }));
    expect(result).toEqual({ granted: true, filters: { orgId: "o1" } });
  });

  it("filters-only resolution grants with the filters (list-shaped)", async () => {
    const filters = { $or: [{ ownerId: "u1" }, { _id: { $in: ["doc-1", "doc-9"] } }] };
    const result = await requireGrant({ mode: "list", resolve: () => ({ filters }) })(
      ctx({ action: "list" }),
    );
    expect(result).toEqual({ granted: true, filters });
  });

  it("empty resolution denies (fail-closed)", async () => {
    const result = await requireGrant({ mode: "read", resolve: () => ({}) })(ctx());
    expect(result).toEqual({ granted: false });
  });

  it("resolver throw denies with a generic reason (fail-closed, logged)", async () => {
    const result = await requireGrant({
      mode: "read",
      resolve: () => {
        throw new Error("grants table on fire: mongodb://admin:secret@internal");
      },
    })(ctx());
    expect(result).toEqual({ granted: false, reason: "Grant lookup failed" });
  });

  it("bypassRoles skip the resolver entirely", async () => {
    let called = false;
    const result = await requireGrant({
      mode: "manage",
      bypassRoles: ["superadmin"],
      resolve: () => {
        called = true;
        return false;
      },
    })(ctx({ user: { id: "admin", role: ["superadmin"] } }));
    expect(result).toBe(true);
    expect(called).toBe(false);
  });

  it("anonymous callers reach the resolver (share-link path) — resolver decides", async () => {
    const seen: Array<string | null> = [];
    const check = requireGrant({
      mode: "read",
      resolve: (c) => {
        seen.push(c.user ? "authed" : "anon");
        // A share-link resolver would validate a signed token from
        // c.request here and return the linked grant's mode.
        return { mode: "read" };
      },
    });
    expect(await check(ctx({ user: null }))).toEqual({ granted: true });
    expect(seen).toEqual(["anon"]);
  });
});

describe("requireGrant — end to end (filters reach the repository query)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("list-shaped grant filters scope the actual repo query; denied single-record get is 403", async () => {
    const capturedFilters: Record<string, unknown>[] = [];
    const grantFilter = { $or: [{ ownerId: "u1" }, { _id: { $in: ["doc-1"] } }] };

    const adapter = {
      repository: {
        // List rides repo-core's pagination contract — the permission
        // filters arrive inside the getAll params.
        getAll: async (params: Record<string, unknown>) => {
          capturedFilters.push(params);
          return { data: [] };
        },
        findById: async (id: string) => ({ _id: id, ownerId: "someone-else" }),
      },
    };

    app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resources: [
        defineResource({
          name: "shareddoc",
          adapter: adapter as never,
          permissions: {
            list: requireGrant({ mode: "list", resolve: () => ({ filters: grantFilter }) }),
            get: requireGrant({ mode: "read", resolve: () => ({ mode: "see" }) }),
          },
        }),
      ],
    });
    await app.ready();

    // List: the grant's $or filter must reach the repository query —
    // shared records arrive via ONE query, not per-item ACL checks.
    const list = await app.inject({ method: "GET", url: "/shareddocs" });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(capturedFilters)).toContain('"$or"');
    expect(JSON.stringify(capturedFilters)).toContain('"doc-1"');

    // Get: held 'see' does not satisfy required 'read' → 401/403, and the
    // handler never runs (no findById leak).
    const get = await app.inject({ method: "GET", url: "/shareddocs/doc-1" });
    expect([401, 403]).toContain(get.statusCode);
  });
});
