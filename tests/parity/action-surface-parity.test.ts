/**
 * Declarative actions (`resource.actions`) must gate the same way on both
 * surfaces — despite being ADDRESSED completely differently.
 *
 * HTTP mounts every action of a resource at one `POST <prefix>/:id/action`
 * endpoint discriminated by an `action` field in the body. MCP emits one tool
 * per action. Two shapes, one permission chain — and the history says the
 * chain is what drifts: 2.11.x shipped custom-route tools that ran their
 * handler regardless of `route.permissions`, so a route gated by
 * `requireRoles(['admin'])` over REST was callable anonymously over MCP.
 *
 * `handler` counts invocations rather than only asserting on the response:
 * "refused" must mean the handler never ran, not that it ran and its output
 * was discarded. A permission check that fires after the side effect is
 * indistinguishable from a working one if you only read the status code.
 */

import { expect, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import { ANONYMOUS, anAdapter, forEachSurface, type Identity } from "../_harness/index.js";

const MEMBER: Identity = { userId: "u1", roles: ["member"] };

const SEED = [{ _id: "t1", name: "one", status: "draft" }];

/**
 * Each surface gets a FRESH spy: `forEachSurface` calls the factory per
 * surface, so a shared spy would carry HTTP's invocation count into the MCP
 * assertion and make a never-ran handler look like it ran.
 */
function withSpy() {
  const handler = vi.fn(async (id: string) => ({ id, status: "published" }));
  const resource = () =>
    defineResource({
      name: "task",
      prefix: "/tasks",
      adapter: anAdapter(SEED),
      permissions: { list: allowPublic(), get: allowPublic(), update: allowPublic() },
      actions: {
        publish: { handler, permissions: requireAuth() },
        archive: { handler, permissions: allowPublic() },
      },
    });
  return { handler, resource };
}

// ── Permission verdicts ─────────────────────────────────────────────────

{
  const { resource } = withSpy();
  forEachSurface("a guarded action refuses an anonymous caller", resource, async (surface) => {
    const r = await surface.callAction({ action: "publish", id: "t1" }, ANONYMOUS);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
}

{
  const { resource } = withSpy();
  forEachSurface("a guarded action allows an authenticated caller", resource, async (surface) => {
    const r = await surface.callAction({ action: "publish", id: "t1" }, MEMBER);
    expect(r.ok).toBe(true);
  });
}

{
  const { resource } = withSpy();
  forEachSurface("a public action allows an anonymous caller", resource, async (surface) => {
    const r = await surface.callAction({ action: "archive", id: "t1" }, ANONYMOUS);
    expect(r.ok).toBe(true);
  });
}

// ── The handler must not run on refusal ─────────────────────────────────

/**
 * Every factory call pushes its spy here. Both surfaces build the resource
 * immediately before invoking it, so the LAST entry is the handler the call
 * under assertion actually wired — which keeps the two surfaces from reading
 * each other's invocation count.
 */
const spies: Array<ReturnType<typeof vi.fn>> = [];

forEachSurface(
  "a refused action never reaches its handler",
  () => {
    const handler = vi.fn(async (id: string) => ({ id, status: "published" }));
    spies.push(handler);
    return defineResource({
      name: "task",
      prefix: "/tasks",
      adapter: anAdapter(SEED),
      permissions: { list: allowPublic(), get: allowPublic(), update: allowPublic() },
      actions: { publish: { handler, permissions: requireAuth() } },
    });
  },
  async (surface) => {
    const r = await surface.callAction({ action: "publish", id: "t1" }, ANONYMOUS);
    expect(r.ok).toBe(false);
    // The SIDE EFFECT is the subject. A 401 returned after the handler ran is
    // still a security defect, and the status code alone cannot see it — so
    // assert on the handler, not just the response.
    expect(spies.at(-1)).not.toHaveBeenCalled();
  },
);

forEachSurface(
  "...and an ALLOWED action does reach it — the check above is not vacuous",
  () => {
    const handler = vi.fn(async (id: string) => ({ id, status: "archived" }));
    spies.push(handler);
    return defineResource({
      name: "task",
      prefix: "/tasks",
      adapter: anAdapter(SEED),
      permissions: { list: allowPublic(), get: allowPublic(), update: allowPublic() },
      actions: { archive: { handler, permissions: allowPublic() } },
    });
  },
  async (surface) => {
    const r = await surface.callAction({ action: "archive", id: "t1" }, ANONYMOUS);
    expect(r.ok).toBe(true);
    expect(spies.at(-1)).toHaveBeenCalledTimes(1);
  },
);

// ── Error envelope ──────────────────────────────────────────────────────

{
  const { resource } = withSpy();
  forEachSurface("an action denial carries arc's error envelope", resource, async (surface) => {
    const r = await surface.callAction({ action: "publish", id: "t1" }, ANONYMOUS);
    expect(r.body).toMatchObject({
      code: expect.stringMatching(/^arc\./),
      message: expect.any(String),
      status: 401,
    });
  });
}
