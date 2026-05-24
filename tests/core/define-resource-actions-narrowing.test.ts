/**
 * `defineResource` actions-type narrowing — DX regression test.
 *
 * Before 2.17.1, `defineResource<TDoc>(config): ResourceDefinition<TDoc>` only
 * generic'd over `TDoc` (document type). The `actions?: ActionsMap` field on
 * the return type stayed optional regardless of whether the host declared a
 * non-empty `actions: { ... }` literal at the call site. Every host that
 * accessed `resource.actions.send(...)` got TS error
 * "'resource.actions' is possibly 'undefined'" — Prism's partner team flagged
 * this in `media-sfx-music.test.ts:64` after an SDK bump tightened the
 * transitive types.
 *
 * 2.17.1 adds a narrow overload that captures the actions literal shape and
 * narrows `actions` on the return type to the exact captured map. The wide
 * overload (no `actions` declared) keeps the pre-2.17.1 signature intact so
 * existing consumers don't break.
 *
 * The runtime body of `defineResource` is unchanged — this file pins the
 * TYPE contract via assignments that would fail to compile if the narrowing
 * regressed.
 */
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { AnyRecord, DataAdapter, IRequestContext } from "../../src/types/index.js";

function stubAdapter(): DataAdapter {
  return {
    repository: {
      async getAll() {
        return [];
      },
      async getById() {
        return null;
      },
      async create(d: AnyRecord) {
        return { _id: "1", ...d };
      },
      async update(_: string, d: AnyRecord) {
        return { _id: "1", ...d };
      },
      async delete() {
        return true;
      },
    },
    type: "custom",
    name: "stub",
  };
}

describe("defineResource — actions type narrowing", () => {
  it("narrows actions to the captured shape when declared as a literal", () => {
    const resource = defineResource({
      name: "media",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        send: async (_id: string, _data, _req) => ({ ok: true }),
        receive: async (_id: string, _data, _req) => ({ received: true }),
      },
    });

    // Type-level: if narrowing regressed, this line would emit
    // "Object is possibly 'undefined'" — the whole point of the fix.
    // Runtime: prove the actions are wired and callable.
    const sendAction = resource.actions.send;
    const receiveAction = resource.actions.receive;

    expect(typeof sendAction).toBe("function");
    expect(typeof receiveAction).toBe("function");
  });

  it("narrowed actions can be invoked without a non-null assertion", async () => {
    const resource = defineResource({
      name: "doc",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        archive: async (id: string, data: { reason?: string }, _req: IRequestContext) => ({
          id,
          archived: true,
          reason: data.reason ?? "n/a",
        }),
      },
    });

    // No `!` or `?.` — narrowing makes the access safe.
    // biome-ignore lint/suspicious/noExplicitAny: action signature is unknown at this scope; runtime call is what we're exercising.
    const action = resource.actions.archive as (id: string, data: any, req: any) => Promise<any>;
    const result = await action("doc-1", { reason: "stale" }, {} as IRequestContext);
    expect(result).toEqual({ id: "doc-1", archived: true, reason: "stale" });
  });

  it("does NOT narrow when actions is omitted (wide overload preserved)", () => {
    const resource = defineResource({
      name: "noactions",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Type-level: `actions` MUST stay `ActionsMap | undefined` here.
    // We guard with optional chaining to prove the wide overload is in play.
    expect(resource.actions?.anything).toBeUndefined();
  });

  it("narrowing survives function-shorthand actions (not just ActionDefinition objects)", () => {
    const resource = defineResource({
      name: "shortform",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        // Function shorthand — distinct from `ActionDefinition` (object form).
        ping: async () => ({ pong: true }),
      },
    });

    // Compile-time assertion: ping is callable directly off resource.actions.
    expect(typeof resource.actions.ping).toBe("function");
  });
});
