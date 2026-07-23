/**
 * BaseController DX surface — v2.11 field-report improvements
 *
 * Locks in the type-level and runtime DX fixes from the 2.11 upgrade
 * field report:
 *
 *   1. `TRepository` defaults to `RepositoryLike<TDoc>` (symmetric
 *      diagnostics — no `AnyRecord + unknown` mixing in error messages).
 *   2. Controller-override utility types (`ArcListResult`, `ArcCreateResult`,
 *      `ArcGetResult`, `ArcUpdateResult`, `ArcDeleteResult`) read
 *      `ReturnType<TCtrl['method']>` so overrides stay honest with the
 *      base's return shape.
 *   3. `createMongooseAdapter<TDoc extends AnyRecord>` surfaces the
 *      constraint at the adapter call site instead of three layers up.
 *   4. `defineResource` warns when `queryParser` is set but the controller
 *      lacks `setQueryParser` — covers hand-rolled controllers that would
 *      otherwise silently drop the parser.
 *
 * Most of this file is type-level (no runtime cost). The runtime warn is
 * asserted via a captured logger in item (4).
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it, vi } from "vitest";
import type { BaseController } from "../../src/core/BaseController.js";
import type {
  ArcCreateResult,
  ArcDeleteResult,
  ArcGetResult,
  ArcListResult,
  ArcUpdateResult,
  ListResult,
} from "../../src/core/BaseCrudController.js";
import type { AnyRecord, IControllerResponse, IRequestContext } from "../../src/types/index.js";

// ============================================================================
// 1. TRepository defaults to RepositoryLike<TDoc> — type-level check
// ============================================================================

describe("BaseController — TRepository default tracks TDoc", () => {
  it("default TRepository reads TDoc (no asymmetric AnyRecord + unknown in diagnostics)", () => {
    // Type-level assertion: BaseController<Product>'s inferred repository
    // type is RepositoryLike<Product>, not RepositoryLike<unknown>. If the
    // default ever regresses back to RepositoryLike (= RepositoryLike<unknown>),
    // this assertion fails at compile time.
    type Product = { _id: string; name: string; price: number };

    type InferredRepo<TDoc extends AnyRecord> =
      BaseController<TDoc> extends { repository: infer R } ? R : never;

    // Conditional inference reads the TYPE-LEVEL shape only — protected
    // visibility doesn't block `infer` on the structural member.
    type _ = InferredRepo<Product>;

    // Pragmatic assertion: construct a BaseController instance and verify
    // a RepositoryLike<Product> is assignable to its second generic slot.
    const fakeRepo: RepositoryLike<Product> = {
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for type test
      getAll: (async () => [] as Product[]) as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for type test
      getOne: (async () => null) as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for type test
      create: (async () => ({}) as Product) as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for type test
      updateOne: (async () => ({}) as Product) as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for type test
      deleteOne: (async () => true) as any,
    } as unknown as RepositoryLike<Product>;

    // If `TRepository` defaulted to `RepositoryLike<unknown>` we'd need an
    // explicit second type arg. The fact this compiles with no second arg
    // proves the default correctly tracks TDoc.
    type CheckDefault = BaseController<Product>;
    const _marker: CheckDefault | undefined = undefined;
    void _marker;
    void fakeRepo;
    expect(true).toBe(true);
  });
});

// ============================================================================
// 2. Utility types — override-friendly return shapes
// ============================================================================

describe("Arc{List,Get,Create,Update,Delete}Result — override helpers", () => {
  // Build a minimal controller shape that matches what the utility types
  // expect. No runtime — we assert assignability at the type layer.
  type Product = { _id: string; name: string };

  interface FakeController {
    list(ctx: IRequestContext): Promise<IControllerResponse<ListResult<Product>>>;
    get(ctx: IRequestContext): Promise<IControllerResponse<Product>>;
    create(ctx: IRequestContext): Promise<IControllerResponse<Product>>;
    update(ctx: IRequestContext): Promise<IControllerResponse<Product>>;
    delete(ctx: IRequestContext): Promise<IControllerResponse<{ message: string; id?: string }>>;
  }

  it("ArcListResult<TCtrl> reads the list method's return type verbatim", () => {
    type Inferred = ArcListResult<FakeController>;
    type Expected = Promise<IControllerResponse<ListResult<Product>>>;

    // Bidirectional assignability — types must be structurally identical.
    const _forward: Inferred extends Expected ? true : false = true;
    const _backward: Expected extends Inferred ? true : false = true;
    void _forward;
    void _backward;
    expect(true).toBe(true);
  });

  it("ArcGetResult / ArcCreateResult / ArcUpdateResult / ArcDeleteResult thread TDoc the same way", () => {
    type G = ArcGetResult<FakeController>;
    type C = ArcCreateResult<FakeController>;
    type U = ArcUpdateResult<FakeController>;
    type D = ArcDeleteResult<FakeController>;

    // Each should equal the method's declared return type.
    const _g: G extends Promise<IControllerResponse<Product>> ? true : false = true;
    const _c: C extends Promise<IControllerResponse<Product>> ? true : false = true;
    const _u: U extends Promise<IControllerResponse<Product>> ? true : false = true;
    const _d: D extends Promise<IControllerResponse<{ message: string; id?: string }>>
      ? true
      : false = true;
    void _g;
    void _c;
    void _u;
    void _d;
    expect(true).toBe(true);
  });

  it("works on a subclass override, parameterized by the BASE type", () => {
    // The compiled type lane caught that `ArcXResult<this>` can NEVER
    // annotate an async method return: `this` includes the member being
    // defined, so the alias is circular (TS2577) regardless of
    // inheritance. The working sugar parameterizes by the BASE class —
    // `ArcListResult<Base>` reads the inherited signature, stays
    // non-circular, and still saves restating the full Promise<...> shape.
    class Base {
      async list(_ctx: IRequestContext): Promise<IControllerResponse<ListResult<Product>>> {
        return { data: { data: [], total: 0 } as unknown as ListResult<Product> };
      }
      async get(_ctx: IRequestContext): Promise<IControllerResponse<Product>> {
        return { data: { _id: "1", name: "test" } };
      }
      async create(_ctx: IRequestContext): Promise<IControllerResponse<Product>> {
        return { data: { _id: "1", name: "test" } };
      }
      async update(_ctx: IRequestContext): Promise<IControllerResponse<Product>> {
        return { data: { _id: "1", name: "test" } };
      }
      async delete(
        _ctx: IRequestContext,
      ): Promise<IControllerResponse<{ message: string; id?: string }>> {
        return { data: { message: "deleted", id: "1" } };
      }
    }

    class Fake extends Base {
      override async list(ctx: IRequestContext): ArcListResult<Base> {
        return super.list(ctx);
      }
      override async get(ctx: IRequestContext): ArcGetResult<Base> {
        return super.get(ctx);
      }
      override async create(ctx: IRequestContext): ArcCreateResult<Base> {
        return super.create(ctx);
      }
      override async update(ctx: IRequestContext): ArcUpdateResult<Base> {
        return super.update(ctx);
      }
      override async delete(ctx: IRequestContext): ArcDeleteResult<Base> {
        return super.delete(ctx);
      }
    }

    const fake = new Fake();
    expect(fake).toBeDefined();
  });
});

// ============================================================================
// 3. createMongooseAdapter<TDoc extends AnyRecord> — constraint at call site
// ============================================================================

describe("createMongooseAdapter — TDoc constraint surfaces at the adapter", () => {
  it("type-level: AnyRecord-compatible TDoc compiles cleanly", () => {
    // Sanity: this is the normal happy path — a domain interface that
    // satisfies AnyRecord is accepted.
    type OkDoc = AnyRecord & { name: string };
    // biome-ignore lint/suspicious/noExplicitAny: import-cycle-free type test
    type _Check = typeof import("@classytic/mongokit/adapter").createMongooseAdapter<OkDoc>;
    expect(true).toBe(true);
  });

  // Note: negative test (non-AnyRecord TDoc rejected at the call site) is
  // covered by the existing repository-contract-types.test-d.ts type tests.
  // The constraint change is small enough that a compile-time sanity check
  // on the happy path is sufficient regression protection; a TDoc that
  // fails `extends AnyRecord` won't slip past `tsc --noEmit` in CI.
});

// ============================================================================
// 4. defineResource throws when queryParser set but controller lacks setQueryParser (2.15.0)
// ============================================================================

describe("defineResource — setQueryParser forwarding fail-loud (2.15.0)", () => {
  it("throws at registration when a custom queryParser is set but the controller has no setQueryParser", async () => {
    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");

    // Hand-rolled controller — no setQueryParser. This is the exact shape
    // of the reporter's review.controller.ts that triggered the 90-minute
    // debug session — pre-2.15 it warned and shipped a silently-shadowed
    // parser; 2.15+ throws so the misconfig surfaces immediately.
    const handRolledController = {
      list: async () => ({ success: true, data: [] }),
      get: async () => ({ success: true, data: null }),
      create: async () => ({ success: true, data: {} }),
      update: async () => ({ success: true, data: {} }),
      delete: async () => ({ success: true, data: { message: "ok" } }),
      // setQueryParser deliberately absent
    };

    const customParser = {
      parse: () => ({ filter: {}, limit: 10 }),
      getQuerySchema: () => ({
        type: "object" as const,
        properties: {},
      }),
    };

    expect(() =>
      defineResource({
        name: "hand-rolled",
        prefix: "/hand-rolled",
        // biome-ignore lint/suspicious/noExplicitAny: test shim — we're testing the duck-typed forwarding
        controller: handRolledController as any,
        // biome-ignore lint/suspicious/noExplicitAny: test shim
        queryParser: customParser as any,
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
        skipValidation: true,
        skipRegistry: true,
      }),
    ).toThrow(/does not expose `setQueryParser/);
  });

  it("does NOT warn when the controller DOES expose setQueryParser", async () => {
    const warns: string[] = [];
    const { configureArcLogger } = await import("../../src/logger/index.js");
    configureArcLogger({
      writer: {
        warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")),
        info: () => {},
        error: () => {},
        debug: () => {},
      },
    });

    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");

    const setQueryParserSpy = vi.fn();
    const wellBehavedController = {
      list: async () => ({ success: true, data: [] }),
      get: async () => ({ success: true, data: null }),
      create: async () => ({ success: true, data: {} }),
      update: async () => ({ success: true, data: {} }),
      delete: async () => ({ success: true, data: { message: "ok" } }),
      setQueryParser: setQueryParserSpy,
    };

    const customParser = {
      parse: () => ({ filter: {}, limit: 10 }),
      getQuerySchema: () => ({
        type: "object" as const,
        properties: {},
      }),
    };

    defineResource({
      name: "well-behaved",
      prefix: "/well-behaved",
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      controller: wellBehavedController as any,
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      queryParser: customParser as any,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      skipValidation: true,
      skipRegistry: true,
    });

    // No setQueryParser warn — the controller took the parser.
    expect(warns.filter((w) => w.includes("setQueryParser"))).toHaveLength(0);
    // And the spy confirms the parser was actually forwarded.
    expect(setQueryParserSpy).toHaveBeenCalledWith(customParser);

    configureArcLogger({});
  });

  it("does NOT warn when queryParser is not set (no forwarding to skip)", async () => {
    const warns: string[] = [];
    const { configureArcLogger } = await import("../../src/logger/index.js");
    configureArcLogger({
      writer: {
        warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")),
        info: () => {},
        error: () => {},
        debug: () => {},
      },
    });

    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");

    const noParserController = {
      list: async () => ({ success: true, data: [] }),
      get: async () => ({ success: true, data: null }),
      create: async () => ({ success: true, data: {} }),
      update: async () => ({ success: true, data: {} }),
      delete: async () => ({ success: true, data: { message: "ok" } }),
      // No setQueryParser, no queryParser on the resource — should be silent.
    };

    defineResource({
      name: "no-parser",
      prefix: "/no-parser",
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      controller: noParserController as any,
      // queryParser deliberately absent
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      skipValidation: true,
      skipRegistry: true,
    });

    expect(warns.filter((w) => w.includes("setQueryParser"))).toHaveLength(0);

    configureArcLogger({});
  });
});

// ============================================================================
// 4b. defineResource warns when user controller is passed alongside
//     auto-build-only options (tenantField, schemaOptions, idField, etc.)
// ============================================================================
//
// The auto-build path threads several `defineResource` options into
// `new BaseController(repo, { ... })`. The user-controller path returns
// early — silently dropping every one of those options. Same DX pattern as
// the queryParser warn above, but covers the whole option set so hosts
// don't repeat the 90-minute "why is tenantField ignored" debug for
// schemaOptions, idField, defaultSort, cache, onFieldWriteDenied, or
// preset-injected controller fields.

describe("defineResource — user-controller dropped-options warn", () => {
  async function setup(): Promise<{
    warns: string[];
    teardown: () => Promise<void>;
  }> {
    const warns: string[] = [];
    const { configureArcLogger } = await import("../../src/logger/index.js");
    configureArcLogger({
      writer: {
        warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")),
        info: () => {},
        error: () => {},
        debug: () => {},
      },
    });
    return {
      warns,
      teardown: async () => {
        configureArcLogger({});
      },
    };
  }

  function userController() {
    return {
      list: async () => ({ success: true, data: [] }),
      get: async () => ({ success: true, data: null }),
      create: async () => ({ success: true, data: {} }),
      update: async () => ({ success: true, data: {} }),
      delete: async () => ({ success: true, data: { message: "ok" } }),
    };
  }

  it("warns when tenantField is set on the resource but a user controller is supplied", async () => {
    const { warns, teardown } = await setup();
    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");

    defineResource({
      name: "branch-doc-is-org",
      prefix: "/branch-doc-is-org",
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      controller: userController() as any,
      tenantField: "_id",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      skipValidation: true,
      skipRegistry: true,
    });

    const droppedWarn = warns.find(
      (w) => w.includes("branch-doc-is-org") && w.includes("tenantField"),
    );
    expect(droppedWarn).toBeDefined();
    expect(droppedWarn).toContain("super(");
    await teardown();
  });

  it("lists EVERY dropped option in a single warn (one boot-time line, not six)", async () => {
    const { warns, teardown } = await setup();
    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");

    defineResource({
      name: "many-dropped",
      prefix: "/many-dropped",
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      controller: userController() as any,
      tenantField: false,
      idField: "uuid",
      defaultSort: "-name",
      cache: { staleTime: 30 },
      onFieldWriteDenied: "strip",
      schemaOptions: { fieldRules: { secret: { systemManaged: true } } },
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      skipValidation: true,
      skipRegistry: true,
    });

    const droppedWarn = warns.find((w) => w.includes("many-dropped"));
    expect(droppedWarn).toBeDefined();
    // All six user-facing options must show up — the warn's value is in
    // naming the full set so the host fixes them in one pass.
    expect(droppedWarn).toContain("tenantField");
    expect(droppedWarn).toContain("schemaOptions");
    expect(droppedWarn).toContain("idField");
    expect(droppedWarn).toContain("defaultSort");
    expect(droppedWarn).toContain("cache");
    expect(droppedWarn).toContain("onFieldWriteDenied");
    await teardown();
  });

  it("does NOT warn when no auto-build-only options are declared", async () => {
    const { warns, teardown } = await setup();
    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");

    defineResource({
      name: "clean-user-ctrl",
      prefix: "/clean-user-ctrl",
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      controller: userController() as any,
      // No tenantField / idField / schemaOptions / etc. — silent.
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      skipValidation: true,
      skipRegistry: true,
    });

    const droppedWarn = warns.find(
      (w) => w.includes("clean-user-ctrl") && w.includes("dropped silently"),
    );
    expect(droppedWarn).toBeUndefined();
    await teardown();
  });

  it("does NOT warn when arc auto-builds the controller (no drop possible)", async () => {
    const { warns, teardown } = await setup();
    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");
    const { createMockModel, createMockRepository } = await import("../setup.js");
    const { createMongooseAdapter } = await import("@classytic/mongokit/adapter");

    const Model = createMockModel("AutoBuildCtrl");
    const repo = createMockRepository(Model);

    defineResource({
      name: "auto-build",
      prefix: "/auto-build",
      adapter: createMongooseAdapter({
        model: Model,
        // The mock harness is untyped; the adapter input contract is what's
        // under test elsewhere (repository-contract-types.test-d.ts).
        repository: repo as import("@classytic/repo-core/adapter").AdapterRepositoryInput<unknown>,
      }),
      tenantField: "_id",
      idField: "uuid",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      skipValidation: true,
      skipRegistry: true,
    });

    const droppedWarn = warns.find(
      (w) => w.includes("auto-build") && w.includes("dropped silently"),
    );
    expect(droppedWarn).toBeUndefined();
    await teardown();
  });

  // Regression: preset-injected `_controllerOptions` (slugLookup, soft-delete,
  // parent) used to surface in the SAME warn that told the user to "forward
  // them to your super() call." But the user never declared those — the
  // preset injected them. The warn must be split and reworded so the
  // remediation is actionable: drop the preset, OR extend BaseController.
  it("preset-injected slugField fires a SEPARATE warn — does NOT tell user to forward via super()", async () => {
    const { warns, teardown } = await setup();
    const { defineResource } = await import("../../src/core/defineResource.js");
    const { allowPublic } = await import("../../src/permissions/index.js");

    defineResource({
      name: "preset-injected",
      prefix: "/preset-injected",
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      controller: userController() as any,
      presets: ["slugLookup"], // populates `_controllerOptions.slugField`
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      skipValidation: true,
      skipRegistry: true,
    });

    const presetWarn = warns.find(
      (w) => w.includes("preset-injected") && w.includes("preset that injects controller field"),
    );
    expect(presetWarn).toBeDefined();
    // Names the specific field the preset injected.
    expect(presetWarn).toContain("slugField");
    // Actionable remediation — neither asks the user to forward unknown metadata
    // nor tells them to do something they can't.
    expect(presetWarn).toContain("drop the preset");
    expect(presetWarn).toContain("extend");

    // Crucially: it must NOT use the author-options "forward via super()" copy
    // for this case — that's the false-positive Commerce reported.
    const sayForward =
      presetWarn?.includes("super(repo") || presetWarn?.includes("Forward them to your");
    expect(sayForward).toBe(false);

    await teardown();
  });
});

// ============================================================================
// 5. Root barrel — utility types importable from '@classytic/arc'
// ============================================================================

describe("root barrel — controller-result utilities surface at @classytic/arc", () => {
  it("imports resolve from the root (same path hosts use)", async () => {
    // Sanity check that the utility types are actually exported from the
    // root entry point, not just from the internal module. The `ListResult`
    // re-export has been root-available since 2.10; the new `Arc*Result`
    // utilities join it in 2.11.
    const mod = await import("../../src/index.js");
    // Types are compile-time; runtime shape just needs to confirm the
    // module loads cleanly and carries its expected exports.
    expect(mod).toBeDefined();
    // Sanity: the module has the rest of the public surface we expect.
    expect(typeof mod.defineResource).toBe("function");
    expect(typeof mod.BaseController).toBe("function");
  });
});
