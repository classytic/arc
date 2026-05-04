/**
 * Tests for arc's resource-dispatch verbs:
 *   `?_count=true`     → repo.count(filter)     → { count: number }
 *   `?_distinct=field` → repo.distinct(field, filter) → unknown[]
 *   `?_exists=true`    → repo.exists(filter)    → { exists: boolean }
 *
 * The list endpoint inspects `req.query` first; if any verb flag is set,
 * the request routes to the corresponding repo method instead of
 * `getAll()`. Same `list` permission gate, same tenant + policy scope,
 * different (smaller) response payload.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";
import { createMockRepository } from "../../src/testing/mocks.js";
import type { IRequestContext } from "../../src/types/index.js";

function createReq(hooks: HookSystem, overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    query: {},
    body: {},
    params: {},
    headers: {},
    user: { id: "user-1", role: "admin" },
    metadata: { arc: { hooks } },
    ...overrides,
  } as unknown as IRequestContext;
}

describe("BaseController — list() resource-dispatch verbs", () => {
  let hooks: HookSystem;
  let repo: ReturnType<typeof createMockRepository>;
  let controller: BaseController;

  beforeEach(() => {
    hooks = new HookSystem();
    repo = createMockRepository();
  });

  describe("_count", () => {
    it("dispatches to repo.count() and returns { count }", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).count = vi.fn().mockResolvedValue(42);
      controller = new BaseController(repo as never, { resourceName: "product" });

      const res = await controller.list(createReq(hooks, { query: { _count: "true" } }));

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ count: 42 });
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      expect((repo as any).count).toHaveBeenCalledTimes(1);
    });

    it("throws 501 when the adapter does not implement count()", async () => {
      controller = new BaseController(repo as never, { resourceName: "product" });
      // Default mock has no count method
      expect(typeof (repo as Record<string, unknown>).count).toBe("undefined");

      await expect(
        controller.list(createReq(hooks, { query: { _count: "true" } })),
      ).rejects.toMatchObject({ status: 501 });
    });

    it("`_count=false` does NOT dispatch (treats as regular list)", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).count = vi.fn().mockResolvedValue(99);
      controller = new BaseController(repo as never, { resourceName: "product" });

      const res = await controller.list(createReq(hooks, { query: { _count: "false" } }));

      // Falls through to getAll → repo.getAll mock returns the empty offset envelope
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      expect((repo as any).count).not.toHaveBeenCalled();
      expect(res.data).not.toEqual({ count: 99 });
    });
  });

  describe("_distinct", () => {
    it("dispatches to repo.distinct(field, filter) and returns the array", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).distinct = vi.fn().mockResolvedValue(["draft", "active", "archived"]);
      controller = new BaseController(repo as never, { resourceName: "product" });

      const res = await controller.list(createReq(hooks, { query: { _distinct: "status" } }));

      expect(res.status).toBe(200);
      expect(res.data).toEqual(["draft", "active", "archived"]);
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      expect((repo as any).distinct).toHaveBeenCalledWith(
        "status",
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("throws 400 for hidden fields — prevents leak via field rules", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).distinct = vi.fn().mockResolvedValue(["secret"]);
      controller = new BaseController(repo as never, {
        resourceName: "user",
        schemaOptions: {
          fieldRules: { passwordHash: { hidden: true } },
        },
      });

      await expect(
        controller.list(createReq(hooks, { query: { _distinct: "passwordHash" } })),
      ).rejects.toMatchObject({ status: 400 });
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      expect((repo as any).distinct).not.toHaveBeenCalled();
    });

    it("throws 400 for systemManaged fields", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).distinct = vi.fn();
      controller = new BaseController(repo as never, {
        resourceName: "user",
        schemaOptions: {
          fieldRules: { internalFlag: { systemManaged: true } },
        },
      });

      await expect(
        controller.list(createReq(hooks, { query: { _distinct: "internalFlag" } })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws 501 when the adapter does not implement distinct()", async () => {
      controller = new BaseController(repo as never, { resourceName: "product" });

      await expect(
        controller.list(createReq(hooks, { query: { _distinct: "status" } })),
      ).rejects.toMatchObject({ status: 501 });
    });

    it("empty/missing _distinct value falls through to regular list", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).distinct = vi.fn();
      controller = new BaseController(repo as never, { resourceName: "product" });

      // Empty string — should NOT dispatch
      await controller.list(createReq(hooks, { query: { _distinct: "" } }));
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      expect((repo as any).distinct).not.toHaveBeenCalled();
    });
  });

  describe("_exists", () => {
    it("dispatches to repo.exists() and normalizes to { exists: true }", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).exists = vi.fn().mockResolvedValue(true);
      controller = new BaseController(repo as never, { resourceName: "product" });

      const res = await controller.list(createReq(hooks, { query: { _exists: "true" } }));

      expect(res.data).toEqual({ exists: true });
    });

    it("normalizes `{ _id }` form to { exists: true }", async () => {
      // Mongo's `findOne({ _id: 1 }, { _id: 1 })` semantics — repo can
      // legally return the matched id object instead of a bare boolean.
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).exists = vi.fn().mockResolvedValue({ _id: "abc123" });
      controller = new BaseController(repo as never, { resourceName: "product" });

      const res = await controller.list(createReq(hooks, { query: { _exists: "true" } }));

      expect(res.data).toEqual({ exists: true });
    });

    it("normalizes `null` to { exists: false }", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).exists = vi.fn().mockResolvedValue(null);
      controller = new BaseController(repo as never, { resourceName: "product" });

      const res = await controller.list(createReq(hooks, { query: { _exists: "true" } }));

      expect(res.data).toEqual({ exists: false });
    });

    it("throws 501 when the adapter does not implement exists()", async () => {
      controller = new BaseController(repo as never, { resourceName: "product" });

      await expect(
        controller.list(createReq(hooks, { query: { _exists: "true" } })),
      ).rejects.toMatchObject({ status: 501 });
    });
  });

  describe("dispatch precedence", () => {
    it("`_count` wins over `_distinct` and `_exists` when multiple set", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).count = vi.fn().mockResolvedValue(7);
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).distinct = vi.fn().mockResolvedValue(["x"]);
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      (repo as any).exists = vi.fn().mockResolvedValue(true);
      controller = new BaseController(repo as never, { resourceName: "product" });

      const res = await controller.list(
        createReq(hooks, {
          query: { _count: "true", _distinct: "status", _exists: "true" },
        }),
      );

      expect(res.data).toEqual({ count: 7 });
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      expect((repo as any).distinct).not.toHaveBeenCalled();
      // biome-ignore lint/suspicious/noExplicitAny: test mock extension
      expect((repo as any).exists).not.toHaveBeenCalled();
    });
  });
});
