/**
 * `HookContext.scope` — the identity source for GLOBAL hooks.
 *
 * `ResourceHookContext` has carried a `scope` projection since 2.10.8; the
 * global HookSystem context did not, so cross-cutting hooks (`hooks.before('*',
 * 'update', …)` — the canonical `updatedBy` stamp) had to reach into the
 * internal `context._scope`. Hosts then wrote their own local context shape and
 * fell back to `ctx.user?.id`, which is the auth adapter's unvalidated view.
 *
 * The projection is the SAME helper `IRequestContext.scope` and
 * `ResourceHookContext.scope` use, so all three surfaces agree by construction.
 */

import { describe, expect, it } from "vitest";
import { HookSystem } from "../../src/hooks/HookSystem.js";
import type { RequestScope } from "../../src/scope/types.js";

const MEMBER: RequestScope = {
  kind: "member",
  userId: "u-1",
  organizationId: "org-1",
  orgRoles: ["admin"],
};

/** The shape arc's Fastify adapter puts on `ctx.context`. */
const contextWith = (scope: RequestScope) => ({ _scope: scope });

describe("HookContext.scope", () => {
  it("projects the validated scope for a before hook", async () => {
    const hooks = new HookSystem();
    let seen: unknown;
    hooks.before("*", "update", async (ctx) => {
      seen = ctx.scope;
    });

    await hooks.executeBefore("product", "update", { id: "p1" }, { context: contextWith(MEMBER) });

    expect(seen).toEqual({ organizationId: "org-1", userId: "u-1", orgRoles: ["admin"] });
  });

  it("projects the scope for after and around hooks too", async () => {
    const seen: Array<string | undefined> = [];

    const afterHooks = new HookSystem();
    afterHooks.after("*", "update", async (ctx) => {
      seen.push(ctx.scope?.userId);
    });
    await afterHooks.executeAfter(
      "product",
      "update",
      { id: "p1" },
      { context: contextWith(MEMBER) },
    );

    const aroundHooks = new HookSystem();
    aroundHooks.register({
      resource: "product",
      operation: "update",
      phase: "around",
      handler: ((ctx: { scope?: { userId?: string } }, next: () => Promise<unknown>) => {
        seen.push(ctx.scope?.userId);
        return next();
      }) as never,
    });
    await aroundHooks.executeAround("product", "update", { id: "p1" }, async () => ({ id: "p1" }), {
      context: contextWith(MEMBER),
    });

    expect(seen).toEqual(["u-1", "u-1"]);
  });

  it("is undefined on a public / unscoped request — hosts guard with `?.`", async () => {
    const hooks = new HookSystem();
    let called = false;
    let seen: unknown = "untouched";
    hooks.before("*", "create", async (ctx) => {
      called = true;
      seen = ctx.scope;
    });

    await hooks.executeBefore("product", "create", { id: "p1" });

    expect(called).toBe(true);
    expect(seen).toBeUndefined();
  });

  it("carries the scope, NOT the auth adapter's `user` — they can disagree", async () => {
    // The whole point: `ctx.user` is whatever the auth adapter attached and is
    // not scope-validated. A hook that stamps `updatedBy` must read `ctx.scope`.
    const hooks = new HookSystem();
    let scopeUser: string | undefined;
    let adapterUser: string | undefined;
    hooks.before("*", "update", async (ctx) => {
      scopeUser = ctx.scope?.userId;
      adapterUser = ctx.user?.id;
    });

    await hooks.executeBefore(
      "product",
      "update",
      { id: "p1" },
      { context: contextWith(MEMBER), user: { id: "spoofed" } as never },
    );

    expect(scopeUser).toBe("u-1");
    expect(adapterUser).toBe("spoofed");
  });

  it("an explicitly-set scope on the incoming context is preserved", async () => {
    // `execute()` is public — a caller that already projected the scope must not
    // have it recomputed (and silently blanked when `context` is absent).
    const hooks = new HookSystem();
    let seen: unknown;
    hooks.before("product", "read", async (ctx) => {
      seen = ctx.scope;
    });

    await hooks.execute({
      resource: "product",
      operation: "read",
      phase: "before",
      scope: { organizationId: "org-9", userId: "u-9" },
    });

    expect(seen).toEqual({ organizationId: "org-9", userId: "u-9" });
  });
});
