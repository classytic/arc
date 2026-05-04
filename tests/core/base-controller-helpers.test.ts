/**
 * Helper-level unit tests for `BaseCrudController` — pins the contracts
 * of the small protected helpers extracted in v2.12 (the
 * `runHookedOpUntilResult` / `runAfterHook` / `requireIdParam` /
 * `isDeleteSuccess` / `cacheResponse` cluster).
 *
 * The integration suite (`base-controller.test.ts` + `*-dx.test.ts` +
 * `*-hardening.test.ts`) covers end-to-end CRUD via the public methods.
 * This file targets the helper boundaries directly so a regression in
 * the helper contract surfaces here even before it propagates into a
 * CRUD-method test.
 *
 * Helpers are `protected`, so we extend the controller in-test to reach
 * them — same pattern mixin authors use in production.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { beforeEach, describe, expect, it } from "vitest";
import { BaseCrudController } from "../../src/core/BaseCrudController.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";
import type { IControllerResponse, IRequestContext } from "../../src/types/index.js";
import { createMockModel, createMockRepository, mockUser, setupGlobalHooks } from "../setup.js";

setupGlobalHooks();

/**
 * Test-only subclass that re-exposes the protected helpers as public
 * methods so vitest can invoke them directly. No behaviour change —
 * just a visibility upgrade.
 */
class ExposedController<TDoc> extends BaseCrudController<TDoc> {
  public callRequireIdParam(req: IRequestContext): string {
    return this.requireIdParam(req);
  }
  public callIsExistsTruthy(result: unknown): boolean {
    return this.isExistsTruthy(result);
  }
  public callCacheResponse<T>(data: T, status: "HIT" | "STALE" | "MISS"): IControllerResponse<T> {
    return this.cacheResponse(data, status);
  }
  public callRunHookedOpUntilResult<TInput, TResult>(
    req: IRequestContext,
    args: {
      op: "create" | "update" | "delete";
      input: TInput;
      meta?: Record<string, unknown>;
      pipeProcessedData?: boolean;
    },
    executor: (processed: TInput) => Promise<TResult>,
  ) {
    return this.runHookedOpUntilResult(req, args, executor);
  }
  public callRunAfterHook(
    req: IRequestContext,
    op: "create" | "update" | "delete",
    data: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    return this.runAfterHook(req, op, data, meta);
  }
}

function createReq(hooks: HookSystem, overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    query: {},
    body: {},
    params: {},
    user: mockUser,
    headers: {},
    metadata: { arc: { hooks } },
    ...overrides,
  };
}

describe("BaseCrudController helpers", () => {
  let controller: ExposedController<{ name: string; _id?: string }>;
  let repository: RepositoryLike;
  let hooks: HookSystem;

  beforeEach(() => {
    hooks = new HookSystem();
    const Model = createMockModel("HelperTest");
    repository = createMockRepository(Model) as RepositoryLike;
    controller = new ExposedController(repository, { resourceName: "helperTest" });
  });

  // ────────────────────────────────────────────────────────────────────
  // requireIdParam
  // ────────────────────────────────────────────────────────────────────

  describe("requireIdParam", () => {
    it("returns the id string when params.id is set", () => {
      const req = createReq(hooks, { params: { id: "abc123" } });
      const result = controller.callRequireIdParam(req);
      expect(result).toBe("abc123");
    });

    it("throws a 400 ArcError when params.id is missing", () => {
      const req = createReq(hooks, { params: {} });
      expect(() => controller.callRequireIdParam(req)).toThrow(/ID parameter is required/);
      try {
        controller.callRequireIdParam(req);
      } catch (err) {
        expect((err as { statusCode: number }).statusCode).toBe(400);
      }
    });

    it("throws a 400 ArcError when params.id is an empty string", () => {
      const req = createReq(hooks, { params: { id: "" } });
      expect(() => controller.callRequireIdParam(req)).toThrow(/ID parameter is required/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (`isDeleteSuccess` was removed in v2.12. The success-shape sniffing
  // it did — `success`/`deletedCount`/fall-through to `true` — was
  // replaced by a simpler truthy-result discriminator inside
  // `BaseController.delete`: a `null`/`undefined`/`false` result throws
  // `NotFoundError`, anything truthy counts as success. The new
  // semantics live entirely in the public delete path and are pinned
  // by `tests/core/base-controller-hardening.test.ts` — there is no
  // helper to test in isolation any more.)
  //
  // ────────────────────────────────────────────────────────────────────
  // isExistsTruthy — cross-adapter shape detection for repo.exists()
  // ────────────────────────────────────────────────────────────────────

  describe("isExistsTruthy", () => {
    it("returns false for the canonical miss shapes", () => {
      // StandardRepo.exists may return null/false on miss — both must
      // collapse to `exists: false` on the wire.
      expect(controller.callIsExistsTruthy(null)).toBe(false);
      expect(controller.callIsExistsTruthy(false)).toBe(false);
      expect(controller.callIsExistsTruthy(undefined)).toBe(false);
    });

    it("returns true for boolean true (kits returning a plain boolean)", () => {
      expect(controller.callIsExistsTruthy(true)).toBe(true);
    });

    it("returns true for `{ _id }` shape (kits returning the matched doc id)", () => {
      // mongokit returns `{ _id: ObjectId }` on hit by default — must
      // surface as truthy without the controller having to know which
      // kit produced it.
      expect(controller.callIsExistsTruthy({ _id: "abc123" })).toBe(true);
      expect(controller.callIsExistsTruthy({ _id: "abc", extra: 1 })).toBe(true);
    });

    it("returns true for empty objects (defensive — non-null is hit)", () => {
      // An empty object is non-null per the contract, so it counts as a
      // hit. Adapters that return `{}` on hit are unusual but valid.
      expect(controller.callIsExistsTruthy({})).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cacheResponse — x-cache envelope builder
  // ────────────────────────────────────────────────────────────────────

  describe("cacheResponse", () => {
    it("constructs a 200 envelope with the data + x-cache header", () => {
      const result = controller.callCacheResponse({ name: "thing" }, "HIT");
      // Wire shape (post-2.12): no `success` envelope — HTTP status
      // discriminates success vs error. The cache helper just stamps
      // status 200 + the x-cache header.
      expect(result).toEqual({
        data: { name: "thing" },
        status: 200,
        headers: { "x-cache": "HIT" },
      });
    });

    it.each([
      "HIT",
      "STALE",
      "MISS",
    ] as const)("passes the %s status verbatim into the x-cache header", (status) => {
      const result = controller.callCacheResponse(null, status);
      expect(result.headers).toEqual({ "x-cache": status });
    });

    it("preserves null/undefined data shapes (used by stale-cache returns)", () => {
      const nullResult = controller.callCacheResponse(null, "STALE");
      expect(nullResult.data).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // runHookedOpUntilResult — before + around without after
  // ────────────────────────────────────────────────────────────────────

  // Contract pinned: the helper returns `TResult` directly on the
  // success path and throws a canonical `BEFORE_<OP>_HOOK_ERROR`
  // ArcError on before-hook failure. The global error handler runs
  // those errors through `toErrorContract()` from
  // `@classytic/repo-core/errors`, so consumers see a uniform wire
  // shape across CRUD ops.
  describe("runHookedOpUntilResult", () => {
    it("runs the executor and returns its result directly when no hooks are wired", async () => {
      // No `resourceName` → hooks short-circuit. Helper degrades to
      // calling the executor and returning its value verbatim.
      const noResourceCtrl = new ExposedController(repository);
      const req = createReq(hooks);
      const result = await noResourceCtrl.callRunHookedOpUntilResult(
        req,
        { op: "create", input: { name: "X" } },
        async (data) => ({ ...data, _id: "id-1" }),
      );
      expect(result).toEqual({ name: "X", _id: "id-1" });
    });

    it("pipes executeBefore's return value through to the executor (default)", async () => {
      hooks.register({
        resource: "helperTest",
        operation: "create",
        phase: "before",
        priority: 1,
        handler: (ctx) => ({
          ...(ctx.data as Record<string, unknown>),
          enrichedField: "added",
        }),
      });

      const req = createReq(hooks);
      let receivedByExecutor: Record<string, unknown> = {};
      const result = await controller.callRunHookedOpUntilResult(
        req,
        { op: "create", input: { name: "X" } },
        async (data) => {
          receivedByExecutor = data as Record<string, unknown>;
          return { id: 1 };
        },
      );

      // Executor gets the before-hook's enriched output, helper
      // returns the executor's value verbatim.
      expect(receivedByExecutor).toEqual({ name: "X", enrichedField: "added" });
      expect(result).toEqual({ id: 1 });
    });

    it("does NOT pipe executeBefore's return when pipeProcessedData: false (delete-style)", async () => {
      hooks.register({
        resource: "helperTest",
        operation: "delete",
        phase: "before",
        priority: 1,
        handler: () => ({ name: "TRANSFORMED" }), // would clobber if piped
      });

      const req = createReq(hooks);
      let receivedByExecutor: Record<string, unknown> = {};
      await controller.callRunHookedOpUntilResult(
        req,
        { op: "delete", input: { name: "ORIGINAL" }, pipeProcessedData: false },
        async (data) => {
          receivedByExecutor = data as Record<string, unknown>;
          return { success: true };
        },
      );

      // Original input reaches the executor — before-hook's return
      // value is discarded under the delete contract.
      expect(receivedByExecutor).toEqual({ name: "ORIGINAL" });
    });

    it("throws BEFORE_<OP>_HOOK_ERROR when executeBefore throws", async () => {
      hooks.register({
        resource: "helperTest",
        operation: "create",
        phase: "before",
        priority: 1,
        handler: () => {
          throw new Error("validation barfed");
        },
      });

      const req = createReq(hooks);
      // The thrown ArcError carries the canonical wire fields:
      //   - `statusCode: 400` / `status: 400` (HttpError mirror)
      //   - `message: "Hook execution failed"`
      //   - `details: { code, message }` — `code` names the failed
      //     hook slot, `message` carries the original error so
      //     callers can surface it without inspecting `cause`.
      await expect(
        controller.callRunHookedOpUntilResult(
          req,
          { op: "create", input: { name: "X" } },
          async () => ({ id: 1 }),
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Hook execution failed",
        details: {
          code: "BEFORE_CREATE_HOOK_ERROR",
          message: "validation barfed",
        },
      });
    });

    it.each([
      ["create", "BEFORE_CREATE_HOOK_ERROR"],
      ["update", "BEFORE_UPDATE_HOOK_ERROR"],
      ["delete", "BEFORE_DELETE_HOOK_ERROR"],
    ] as const)("derives the canonical error code for op=%s", async (op, expectedCode) => {
      hooks.register({
        resource: "helperTest",
        operation: op,
        phase: "before",
        priority: 1,
        handler: () => {
          throw new Error("hook bad");
        },
      });
      const req = createReq(hooks);
      await expect(
        controller.callRunHookedOpUntilResult(req, { op, input: { name: "X" } }, async () => ({})),
      ).rejects.toMatchObject({
        statusCode: 400,
        details: { code: expectedCode },
      });
    });

    it("forwards meta into hook options", async () => {
      let capturedMeta: Record<string, unknown> | undefined;
      hooks.register({
        resource: "helperTest",
        operation: "update",
        phase: "before",
        priority: 1,
        handler: (ctx) => {
          capturedMeta = ctx.meta;
          return ctx.data;
        },
      });
      const req = createReq(hooks);
      const meta = { id: "abc", existing: { name: "old" } };
      await controller.callRunHookedOpUntilResult(
        req,
        { op: "update", input: { name: "new" }, meta },
        async () => ({}),
      );
      expect(capturedMeta).toEqual(meta);
    });

    it("returns the around-phase result, not the executor's direct return", async () => {
      // An around-hook can wrap the executor and transform the result.
      // The helper must surface the around-transformed value.
      hooks.register({
        resource: "helperTest",
        operation: "create",
        phase: "around",
        priority: 1,
        // Around handlers receive (ctx, next) — see HookSystem.AroundHookHandler.
        // Cast through unknown because HookSystem.register's generic
        // narrows to HookHandler (no `next`); the runtime form for around
        // hooks does pass `next` as the second arg.
        handler: (async (_ctx: unknown, next: () => Promise<unknown>) => {
          const inner = (await next()) as Record<string, unknown> | undefined;
          return { ...(inner ?? {}), wrappedBy: "around-hook" };
        }) as never,
      });

      const req = createReq(hooks);
      const result = await controller.callRunHookedOpUntilResult(
        req,
        { op: "create", input: { name: "X" } },
        async () => ({ id: 1 }),
      );

      expect(result).toEqual({ id: 1, wrappedBy: "around-hook" });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // runAfterHook
  // ────────────────────────────────────────────────────────────────────

  describe("runAfterHook", () => {
    it("invokes registered after-hooks with the given data + meta", async () => {
      let captured: { data?: unknown; meta?: unknown } = {};
      hooks.register({
        resource: "helperTest",
        operation: "create",
        phase: "after",
        priority: 1,
        handler: (ctx) => {
          // After-hooks receive the data on `ctx.result` (see
          // HookSystem.executeAfter — it sets `result`, not `data`).
          captured = { data: ctx.result, meta: ctx.meta };
        },
      });

      const req = createReq(hooks);
      await controller.callRunAfterHook(req, "create", { id: 1, name: "X" }, { source: "test" });

      expect(captured.data).toEqual({ id: 1, name: "X" });
      expect(captured.meta).toEqual({ source: "test" });
    });

    it("is a no-op when no resourceName is set", async () => {
      const noResourceCtrl = new ExposedController(repository);
      // Even with a hook registered against another resource, the no-resource
      // controller skips the after-call entirely. This shouldn't throw.
      const req = createReq(hooks);
      await expect(
        noResourceCtrl.callRunAfterHook(req, "create", { id: 1 }),
      ).resolves.toBeUndefined();
    });

    it("is a no-op when the request has no hook system attached", async () => {
      // An empty arc context means no hooks — common in CLI / cron paths
      // that bypass the request-context plumbing.
      const reqWithoutHooks: IRequestContext = {
        query: {},
        body: {},
        params: {},
        user: mockUser,
        headers: {},
        metadata: undefined,
      };
      await expect(
        controller.callRunAfterHook(reqWithoutHooks, "create", { id: 1 }),
      ).resolves.toBeUndefined();
    });

    it("omits the meta key from hook options when not provided", async () => {
      let optsHadMeta: boolean | undefined;
      hooks.register({
        resource: "helperTest",
        operation: "delete",
        phase: "after",
        priority: 1,
        handler: (ctx) => {
          optsHadMeta = ctx.meta !== undefined;
        },
      });

      const req = createReq(hooks);
      await controller.callRunAfterHook(req, "delete", { id: 1 });

      // No meta passed → hook options should NOT carry a meta key (avoids
      // a downstream `meta: undefined` reaching consumers expecting absence).
      expect(optsHadMeta).toBe(false);
    });
  });
});
