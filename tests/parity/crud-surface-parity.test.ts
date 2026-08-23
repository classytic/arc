/**
 * HTTP and MCP must answer the SAME question the same way.
 *
 * Each block below is one decision arc makes twice — once per transport. The
 * assertion is written once and the transport is a parameter, so a surface
 * that drifts cannot be green on the other one. See `tests/_harness/surfaces.ts`
 * for why this file exists rather than a second copy of the HTTP suite.
 */

import { expect } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic, fields, requireAuth } from "../../src/permissions/index.js";
import { ANONYMOUS, anAdapter, forEachSurface, type Identity } from "../_harness/index.js";

/**
 * Deliberately NO `orgId`: a member scope carrying one makes arc apply tenant
 * isolation, so an untagged fixture row 404s as `ORG_SCOPE_DENIED` — correct,
 * but it would silently turn every field/permission assertion below into a
 * tenancy assertion. Tenancy gets its own block with org-tagged rows.
 */
const MEMBER: Identity = { userId: "u1", roles: ["member"] };

/** The tenant-scoped caller, used only where tenancy IS the subject. */
const ORG_MEMBER: Identity = { userId: "u1", roles: ["member"], orgId: "org1" };

const SEED = [
  { _id: "t1", name: "one", secret: "classified" },
  { _id: "t2", name: "two", secret: "classified" },
];

/** Reads public, writes authenticated — the most common real matrix. */
const guarded = () =>
  defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter(SEED),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: requireAuth(),
      update: requireAuth(),
      delete: requireAuth(),
    },
  });

// ── Permission verdicts ─────────────────────────────────────────────────

forEachSurface("an anonymous WRITE is refused with 401", guarded, async (surface) => {
  const r = await surface.call({ op: "create", body: { name: "new" } }, ANONYMOUS);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(401);
});

forEachSurface("an authenticated WRITE is allowed", guarded, async (surface) => {
  const r = await surface.call({ op: "create", body: { name: "new" } }, MEMBER);
  expect(r.ok).toBe(true);
});

forEachSurface("a public READ is allowed anonymously", guarded, async (surface) => {
  const r = await surface.call({ op: "list" }, ANONYMOUS);
  expect(r.ok).toBe(true);
});

// ── Error envelope ──────────────────────────────────────────────────────

forEachSurface("a denial carries arc's error envelope", guarded, async (surface) => {
  const r = await surface.call({ op: "delete", id: "t1" }, ANONYMOUS);
  // The envelope is the CROSS-SURFACE contract: MCP embeds this exact object
  // in its error text, so a shape change on one side must break both.
  expect(r.body).toMatchObject({
    code: expect.stringMatching(/^arc\./),
    message: expect.any(String),
    status: 401,
  });
});

// ── Field-level read masking ────────────────────────────────────────────

const masked = () =>
  defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter(SEED),
    permissions: { list: allowPublic(), get: allowPublic() },
    fields: { secret: fields.visibleTo(["member"]) },
  });

forEachSurface("a field the caller cannot READ is absent", masked, async (surface) => {
  const r = await surface.call({ op: "get", id: "t1" }, ANONYMOUS);
  expect(r.ok).toBe(true);
  expect(JSON.stringify(r.body)).not.toContain("classified");
});

forEachSurface("...and present once the caller may read it", masked, async (surface) => {
  const r = await surface.call({ op: "get", id: "t1" }, MEMBER);
  expect(r.ok).toBe(true);
  expect(JSON.stringify(r.body)).toContain("classified");
});

// ── Tenant isolation ────────────────────────────────────────────────────

/**
 * Written because the first draft of this suite made every field assertion
 * accidentally depend on tenancy — the org-scoped 404 is easy to mistake for
 * a masking bug. Isolating it here keeps both readable.
 */
const tenanted = () =>
  defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter([
      { _id: "mine", name: "ours", organizationId: "org1" },
      { _id: "theirs", name: "not ours", organizationId: "org2" },
    ]),
    permissions: { list: allowPublic(), get: allowPublic() },
  });

forEachSurface("a member reads a row inside their org", tenanted, async (surface) => {
  const r = await surface.call({ op: "get", id: "mine" }, ORG_MEMBER);
  expect(r.ok).toBe(true);
});

forEachSurface("a member is 404'd on ANOTHER org's row", tenanted, async (surface) => {
  // 404, never 403: existence itself is tenant-private, and leaking it on one
  // surface while hiding it on the other is exactly the drift worth pinning.
  const r = await surface.call({ op: "get", id: "theirs" }, ORG_MEMBER);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(404);
});
