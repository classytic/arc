/**
 * `hooks.after(resource, 'list' | 'read', fn)` actually FIRES.
 *
 * `HookOperation` has always included `'read'` and `'list'`, so registering an
 * after-hook for a read type-checked, registered successfully, and then never
 * ran: nothing in the controller called `executeAfter` for those operations.
 * AROUND hooks did fire for reads, which made the gap easy to miss — the read
 * path was demonstrably hooked, just not at that phase.
 *
 * A silently-ignored registration is the failure arc's own rules single out:
 * "a declaration that cannot take effect refuses to register", and "prefer a
 * boot throw over a runtime warn, and a runtime warn over a silent drop". This
 * was the silent drop.
 *
 * Deliberately NOT added: `afterList` / `afterGet` keys on the resource-level
 * `hooks: {}` config. `around` already covers read transformation there, and a
 * second spelling of the same capability is what the design rules call a
 * future divergence.
 */

import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { anAdapter, arcApp } from "../_harness/index.js";

const SEED = [
  { _id: "t1", name: "one" },
  { _id: "t2", name: "two" },
];

/** Register hooks against the app's shared HookSystem, as a host would. */
async function appWithHooks(register: (hooks: HookRegistrar) => void) {
  const resource = defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter(SEED),
    permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
  });

  return arcApp({
    resources: [resource],
    plugins: async (fastify) => {
      const hooks = (fastify as unknown as { arc?: { hooks?: HookRegistrar } }).arc?.hooks;
      if (hooks) register(hooks);
    },
  } as never);
}

interface HookRegistrar {
  after(resource: string, op: string, handler: (ctx: unknown) => unknown): unknown;
  around(
    resource: string,
    op: string,
    handler: (ctx: unknown, next: () => unknown) => unknown,
  ): unknown;
}

describe("after-hooks on the READ path", () => {
  it("after('list') fires once per list request", async () => {
    const afterList = vi.fn();
    const app = await appWithHooks((h) => h.after("task", "list", afterList));

    const res = await app.inject({ method: "GET", url: "/tasks" });

    expect(res.statusCode).toBe(200);
    expect(afterList).toHaveBeenCalledTimes(1);
  });

  it("after('read') fires once per get request", async () => {
    const afterRead = vi.fn();
    const app = await appWithHooks((h) => h.after("task", "read", afterRead));

    const res = await app.inject({ method: "GET", url: "/tasks/t1" });

    expect(res.statusCode).toBe(200);
    expect(afterRead).toHaveBeenCalledTimes(1);
  });

  it("after('read') receives the document", async () => {
    // The handler has to get something usable, or firing is theatre.
    let seen: unknown;
    const app = await appWithHooks((h) =>
      h.after("task", "read", (ctx) => {
        seen = (ctx as { result?: unknown }).result;
      }),
    );

    await app.inject({ method: "GET", url: "/tasks/t1" });

    expect(seen).toMatchObject({ _id: "t1" });
  });

  it("a MISSING document does not fire after('read')", async () => {
    // A 404 has nothing to hand a handler; firing with null would force every
    // after-read hook to null-guard before doing anything.
    const afterRead = vi.fn();
    const app = await appWithHooks((h) => h.after("task", "read", afterRead));

    const res = await app.inject({ method: "GET", url: "/tasks/nope" });

    expect(res.statusCode).toBe(404);
    expect(afterRead).not.toHaveBeenCalled();
  });

  it("a read does NOT fire write after-hooks", async () => {
    // Guards the wiring: routing reads into the wrong operation key would
    // satisfy the tests above while firing every host's afterCreate on a GET.
    const afterCreate = vi.fn();
    const app = await appWithHooks((h) => h.after("task", "create", afterCreate));

    await app.inject({ method: "GET", url: "/tasks" });
    await app.inject({ method: "GET", url: "/tasks/t1" });

    expect(afterCreate).not.toHaveBeenCalled();
  });

  it("writes still fire their own after-hooks", async () => {
    // The inverse control — the create path must be untouched by this change.
    const afterCreate = vi.fn();
    const app = await appWithHooks((h) => h.after("task", "create", afterCreate));

    await app.inject({ method: "POST", url: "/tasks", payload: { name: "new" } });

    expect(afterCreate).toHaveBeenCalledTimes(1);
  });

  it("AROUND hooks on reads keep working", async () => {
    // They already fired before this change; the after wiring must not disturb
    // them, since around is the documented way to TRANSFORM a read.
    const aroundList = vi.fn((_ctx: unknown, next: () => unknown) => next());
    const app = await appWithHooks((h) => h.around("task", "list", aroundList));

    const res = await app.inject({ method: "GET", url: "/tasks" });

    expect(res.statusCode).toBe(200);
    expect(aroundList).toHaveBeenCalledTimes(1);
  });
});
