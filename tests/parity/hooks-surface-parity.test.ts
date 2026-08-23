/**
 * Resource hooks must fire on BOTH surfaces, for the same mutation.
 *
 * This is the defect the execution-wiring work was created to fix: MCP's
 * synthetic request context carried no `metadata.arc.hooks`, so every
 * resource hook silently no-oped on an MCP call. An agent could create
 * records while `beforeCreate` validation, `afterCreate` side effects, and —
 * through arcCorePlugin's wildcard after-hook — ALL `<resource>.<op>d` event
 * publishing never happened. Realtime feeds, webhooks, and subscribers heard
 * nothing. Nothing failed, because hooks were only ever asserted over HTTP.
 *
 * Event publishing rides this same wiring: arcCorePlugin registers its
 * publisher AS an after-hook, so "hooks reach MCP" and "events reach MCP" are
 * one fact, pinned once here. The publisher glue itself is covered by
 * `tests/integrations/mcp/mcp-execution-parity.test.ts`.
 */

import { expect, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { anAdapter, forEachSurface, type Identity } from "../_harness/index.js";

const MEMBER: Identity = { userId: "u1", roles: ["member"] };

/**
 * One spy pair per factory call. Both surfaces build the resource immediately
 * before invoking it, so the last entry belongs to the call under assertion —
 * which is what stops HTTP's invocation count leaking into MCP's.
 */
const calls: Array<{ before: ReturnType<typeof vi.fn>; after: ReturnType<typeof vi.fn> }> = [];

function hooked() {
  const before = vi.fn();
  const after = vi.fn();
  calls.push({ before, after });
  return defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter([{ _id: "t1", name: "one" }]),
    permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
    hooks: {
      beforeCreate: () => {
        before();
      },
      afterCreate: () => {
        after();
      },
    },
  });
}

forEachSurface("beforeCreate fires", hooked, async (surface) => {
  const r = await surface.call({ op: "create", body: { name: "new" } }, MEMBER);
  expect(r.ok).toBe(true);
  expect(calls.at(-1)?.before).toHaveBeenCalledTimes(1);
});

forEachSurface("afterCreate fires", hooked, async (surface) => {
  const r = await surface.call({ op: "create", body: { name: "new" } }, MEMBER);
  expect(r.ok).toBe(true);
  // The after-hook is the one event publishing hangs off — if this is silent
  // on a surface, every downstream consumer is silent on that surface too.
  expect(calls.at(-1)?.after).toHaveBeenCalledTimes(1);
});

forEachSurface("a READ does not fire create hooks", hooked, async (surface) => {
  // Guards the two assertions above: a hook system that fired on everything
  // would satisfy them while being obviously wrong.
  await surface.call({ op: "get", id: "t1" }, MEMBER);
  expect(calls.at(-1)?.before).not.toHaveBeenCalled();
  expect(calls.at(-1)?.after).not.toHaveBeenCalled();
});
