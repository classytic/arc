/**
 * The two decisions that ACTUALLY drifted between surfaces this cycle.
 *
 *   1. Scope dimensions. MCP's synthetic scope dropped `teamId` from member
 *      scopes, so a permission check reading `scope.teamId` denied over MCP
 *      and allowed over HTTP for the same caller. Nothing failed: the HTTP
 *      test was green and there was no MCP equivalent.
 *
 *   2. Field-level WRITE rules. Read masking had cross-surface tests; the
 *      write side did not, even though it is the half that decides whether a
 *      caller can ESCALATE — `fields.writableBy(['admin'])` on a role column
 *      is the difference between a member editing their profile and a member
 *      making themselves an admin.
 *
 * Both are pinned here as one assertion per decision, transport as parameter.
 */

import { expect } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic, fields } from "../../src/permissions/index.js";
import type { PermissionCheck } from "../../src/permissions/types.js";
import { ANONYMOUS, anAdapter, forEachSurface, type Identity } from "../_harness/index.js";

/**
 * `teamId` only survives onto a MEMBER scope, which requires an org — so the
 * org is load-bearing here, not incidental. Rows are org-tagged to match, or
 * tenant isolation would 404 before the check under test ever runs.
 */
const TEAM_MEMBER: Identity = {
  userId: "u1",
  roles: ["member"],
  orgId: "org1",
  teamId: "team1",
};
const OTHER_TEAM: Identity = { ...TEAM_MEMBER, teamId: "team2" };

const ROWS = [{ _id: "t1", name: "one", organizationId: "org1", role: "member" }];

// ── Scope dimensions ────────────────────────────────────────────────────

/** Reads `scope.teamId` — the exact dimension MCP used to drop. */
const requireTeam1 = ((ctx: { scope?: { teamId?: string } }) =>
  ctx.scope?.teamId === "team1"
    ? { effect: "allow" as const }
    : { effect: "deny" as const, reason: "wrong team" }) as unknown as PermissionCheck;

const teamGated = () =>
  defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter(ROWS),
    permissions: { list: allowPublic(), get: requireTeam1 },
  });

forEachSurface("a scope dimension (teamId) reaches the permission check", teamGated, async (s) => {
  const r = await s.call({ op: "get", id: "t1" }, TEAM_MEMBER);
  expect(r.ok).toBe(true);
});

forEachSurface(
  "...and the WRONG team is refused — the check is not vacuous",
  teamGated,
  async (s) => {
    const r = await s.call({ op: "get", id: "t1" }, OTHER_TEAM);
    expect(r.ok).toBe(false);
  },
);

forEachSurface("...and an anonymous caller carries no team at all", teamGated, async (surface) => {
  const r = await surface.call({ op: "get", id: "t1" }, ANONYMOUS);
  expect(r.ok).toBe(false);
});

// ── Field-level WRITE rules ─────────────────────────────────────────────

/**
 * `role` is admin-writable. A member creating a record must not be able to
 * set it — arc's default `onFieldWriteDenied` is `reject`, so this is a
 * refusal rather than a silent strip.
 */
const writeGated = () =>
  defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter(ROWS),
    permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
    fields: { role: fields.writableBy(["admin"]) },
  });

forEachSurface("writing an admin-only field is REFUSED for a member", writeGated, async (s) => {
  const r = await s.call({ op: "create", body: { name: "new", role: "admin" } }, TEAM_MEMBER);
  // Default policy is `reject` (403), never a quiet strip — a silent strip
  // would let a privilege-escalation attempt look like a successful write.
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
});

forEachSurface("...while a field the caller MAY write goes through", writeGated, async (s) => {
  const r = await s.call({ op: "create", body: { name: "new" } }, TEAM_MEMBER);
  expect(r.ok).toBe(true);
});
