/**
 * Custom routes (`resource.routes`) must gate identically on both surfaces.
 *
 * This is the family with the worst record. Arc 2.11.x exposed custom routes
 * as MCP tools that ignored `route.permissions` outright: a route gated with
 * `requireRoles(['admin'])` over REST was callable ANONYMOUSLY over MCP. That
 * regression was caught, but only by an MCP-side test — nothing forced the two
 * surfaces to agree, so the same class could recur on the next route feature.
 *
 * The handler spy is the real assertion. A permission gate that runs AFTER
 * dispatch returns the right status while the side effect has already
 * happened, and no status-code assertion can tell those apart.
 */

import { expect, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import { ANONYMOUS, anAdapter, forEachSurface, type Identity } from "../_harness/index.js";

const MEMBER: Identity = { userId: "u1", roles: ["member"] };

/** One spy per factory call; the last entry belongs to the call under test. */
const spies: Array<ReturnType<typeof vi.fn>> = [];

function withRoutes() {
  const handler = vi.fn(async () => ({ exported: true }));
  spies.push(handler);
  return defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter([{ _id: "t1", name: "one" }]),
    permissions: { list: allowPublic(), get: allowPublic() },
    routes: [
      {
        method: "POST",
        path: "/export",
        operation: "export_report",
        handler,
        permissions: requireAuth(),
      },
      {
        method: "POST",
        path: "/ping",
        operation: "ping",
        handler,
        permissions: allowPublic(),
      },
    ],
  });
}

// ── Permission verdicts ─────────────────────────────────────────────────

forEachSurface(
  "a guarded custom route refuses an anonymous caller",
  withRoutes,
  async (surface) => {
    const r = await surface.callRoute({ method: "POST", path: "/export" }, ANONYMOUS);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  },
);

forEachSurface("...and the handler never ran", withRoutes, async (surface) => {
  await surface.callRoute({ method: "POST", path: "/export" }, ANONYMOUS);
  // The 2.11.x defect returned a refusal on REST while MCP dispatched anyway.
  expect(spies.at(-1)).not.toHaveBeenCalled();
});

forEachSurface("a guarded custom route allows an authenticated caller", withRoutes, async (s) => {
  const r = await s.callRoute({ method: "POST", path: "/export" }, MEMBER);
  expect(r.ok).toBe(true);
  expect(spies.at(-1)).toHaveBeenCalledTimes(1);
});

forEachSurface("a public custom route allows an anonymous caller", withRoutes, async (surface) => {
  const r = await surface.callRoute({ method: "POST", path: "/ping" }, ANONYMOUS);
  expect(r.ok).toBe(true);
});

// ── Error envelope ──────────────────────────────────────────────────────

forEachSurface("a route denial carries arc's error envelope", withRoutes, async (surface) => {
  const r = await surface.callRoute({ method: "POST", path: "/export" }, ANONYMOUS);
  expect(r.body).toMatchObject({
    code: expect.stringMatching(/^arc\./),
    message: expect.any(String),
    status: 401,
  });
});
