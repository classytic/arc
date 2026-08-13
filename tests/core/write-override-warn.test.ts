/**
 * WRITE-SLOT OWNERSHIP — one owner per slot, enforced at registration.
 *
 * Route dispatch calls `controller.update`; a declared `writes.update` is
 * consulted INSIDE arc's method. So an override and a verb on the same slot
 * cannot coexist: the override answers the route and the verb is dead code
 * that reads as if it guards it. Measured before this was enforced:
 * `verbCalled: 0`, the override responded, generic behaviour served the route.
 *
 * Three regimes, three outcomes:
 *
 *   1. verb declared + slot overridden          → registration THROWS
 *   2. verb declared + controller not capable    → registration THROWS
 *   3. slot overridden + field protection, no verb → boot WARN (legacy path)
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { BaseCrudController } from "../../src/core/BaseCrudController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/core.js";
import type { IRequestContext } from "../../src/types/index.js";
import type { RepositoryLike } from "../../src/types/repository.js";

const stubRepo = {
  getOne: async () => null,
  getById: async () => null,
  getAll: async () => [],
  create: async (d: unknown) => d,
  update: async () => null,
  delete: async () => false,
} as unknown as RepositoryLike<{ id: string }>;

const adapter: DataAdapter<{ id: string }> = {
  type: "custom",
  name: "stub",
  repository: stubRepo,
};

/** The protection an override discards — this is what makes the warn relevant. */
const PROTECTED = { fieldRules: { status: { systemManaged: true } } };

const PERMISSIONS = {
  list: allowPublic(),
  get: allowPublic(),
  create: allowPublic(),
  update: allowPublic(),
  delete: allowPublic(),
};

function build(controller: unknown, extra: Record<string, unknown> = {}) {
  return defineResource({
    name: "invoice",
    adapter,
    controller,
    schemaOptions: PROTECTED,
    permissions: PERMISSIONS,
    ...extra,
    // biome-ignore lint/suspicious/noExplicitAny: resource config shape under test
  } as any);
}

class FieldOverride extends BaseController<{ id: string }> {
  update = async (_req: IRequestContext) => ({
    data: {} as { id: string },
    status: 200,
  });
}

class PrototypeOverride extends BaseController<{ id: string }> {
  async update(_req: IRequestContext) {
    return { data: {} as { id: string }, status: 200 };
  }
}

describe("write-slot ownership — registration errors", () => {
  it("THROWS when a CLASS-FIELD override and a declared verb claim the same slot", () => {
    // Before enforcement this registered silently and the verb never ran —
    // the exact configuration the reachability check exists to refuse.
    expect(() =>
      build(new FieldOverride(stubRepo), { writes: { update: async () => ({ id: "x" }) } }),
    ).toThrow(/can never execute/);
  });

  it("THROWS when a PROTOTYPE-method override and a declared verb claim the same slot", () => {
    expect(() =>
      build(new PrototypeOverride(stubRepo), { writes: { update: async () => ({ id: "x" }) } }),
    ).toThrow(/can never execute/);
  });

  it("THROWS even when the override delegates to super — hooks are the wrapper seam", () => {
    // Reachability THROUGH a delegating override is statically unprovable, so
    // the contract forbids the combination rather than guessing.
    class DelegatingOverride extends BaseController<{ id: string }> {
      async update(req: IRequestContext) {
        return super.update(req);
      }
    }
    expect(() =>
      build(new DelegatingOverride(stubRepo), { writes: { update: async () => ({ id: "x" }) } }),
    ).toThrow(/can never execute/);
  });

  it("THROWS when the controller is a custom object with no write-verb dispatch", () => {
    const custom = {
      list: async () => ({ data: [], status: 200 }),
      get: async () => ({ data: {}, status: 200 }),
      create: async () => ({ data: {}, status: 201 }),
      update: async () => ({ data: {}, status: 200 }),
      delete: async () => ({ data: {}, status: 200 }),
    };
    expect(() => build(custom, { writes: { update: async () => ({ id: "x" }) } })).toThrow(
      /not built on arc's write pipeline/,
    );
  });

  it("THROWS for a custom controller even when it duck-types configure()", () => {
    // A configure() channel proves options can be delivered — not that
    // anything dispatches `writes` out of them. Capability, not shape.
    const custom = {
      list: async () => ({ data: [], status: 200 }),
      get: async () => ({ data: {}, status: 200 }),
      create: async () => ({ data: {}, status: 201 }),
      update: async () => ({ data: {}, status: 200 }),
      delete: async () => ({ data: {}, status: 200 }),
      configure: (_opts: Record<string, unknown>) => {},
    };
    expect(() => build(custom, { writes: { update: async () => ({ id: "x" }) } })).toThrow(
      /not built on arc's write pipeline/,
    );
  });

  it("registers cleanly when the verb owns an UN-overridden slot", () => {
    expect(() =>
      build(new BaseController<{ id: string }>(stubRepo), {
        writes: { update: async () => ({ id: "x" }) },
      }),
    ).not.toThrow();
  });

  it("an override on a DIFFERENT slot does not block the declared verb", () => {
    // create is overridden; the verb owns update. No collision — the create
    // override falls to the legacy warn below, not to an error.
    expect(() =>
      build(
        new (class extends BaseController<{ id: string }> {
          create = async (_req: IRequestContext) => ({
            data: {} as { id: string },
            status: 201,
          });
        })(stubRepo),
        { writes: { update: async () => ({ id: "x" }) } },
      ),
    ).not.toThrow();
  });

  it("a direct BaseCrudController extender is capable too — the mark travels the chain", () => {
    class Slim extends BaseCrudController<{ id: string }> {}
    expect(() =>
      build(new Slim(stubRepo), { writes: { update: async () => ({ id: "x" }) } }),
    ).not.toThrow();
  });
});

describe("write-method override warn (legacy path — no verb declared)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Restore FIRST: re-spying an already-mocked `console.warn` hands back the
    // same mock, so without this the recorded calls accumulate across cases and
    // every "stays quiet" assertion fails on the previous test's warning.
    vi.restoreAllMocks();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function warnedAboutOverride(): boolean {
    return warn.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("overrides controller method")),
    );
  }

  it("fires for a PROTOTYPE-method override discarding field protection", () => {
    build(new PrototypeOverride(stubRepo));
    expect(warnedAboutOverride()).toBe(true);
  });

  it("fires for a CLASS-FIELD override — same hazard, different shape", () => {
    build(new FieldOverride(stubRepo));
    expect(warnedAboutOverride()).toBe(true);
  });

  it("stays quiet for an un-overridden controller", () => {
    build(new BaseController<{ id: string }>(stubRepo));
    expect(warnedAboutOverride()).toBe(false);
  });

  it("stays quiet when the resource declares no field protection", () => {
    defineResource({
      name: "invoice",
      adapter,
      controller: new FieldOverride(stubRepo),
      permissions: PERMISSIONS,
      // biome-ignore lint/suspicious/noExplicitAny: resource config shape under test
    } as any);
    expect(warnedAboutOverride()).toBe(false);
  });
});

describe("arc's own layers define no write methods (chain-walk precondition)", () => {
  /**
   * `detectOverriddenWriteSlots` treats every prototype between the instance
   * and the capability-marked one as HOST-authored. That is only sound while
   * arc's mixin layers (`BaseController`'s composition) put no
   * create/update/delete on their prototypes. If a future mixin ever does,
   * this test fails before any host sees a false positive.
   */
  it("a plain BaseController triggers no override detection", () => {
    expect(() =>
      build(new BaseController<{ id: string }>(stubRepo), {
        writes: {
          create: async () => ({ id: "x" }),
          update: async () => ({ id: "x" }),
          delete: async () => undefined,
        },
      }),
    ).not.toThrow();
  });
});
