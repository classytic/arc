import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../../src/core/defineResource.js";
import { MemoryIdempotencyStore } from "../../../src/idempotency/stores/memory.js";
import { runIdempotentTool } from "../../../src/integrations/mcp/http-parity.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import { authenticated } from "../../../src/permissions/presets.js";

describe("MCP idempotency security context", () => {
  it.each([
    [undefined, undefined, 30_000, 86_400_000],
    [75_000, 120_000, 75_000, 120_000],
  ])(
    "uses shared configured lock and result lifetimes (%s, %s)",
    async (lockMs, ttlMs, expectedLock, expectedTtl) => {
      const store = new MemoryIdempotencyStore();
      const lock = vi.spyOn(store, "tryLock");
      const completion = vi.spyOn(store, "setIfLocked");
      const controller = { create: vi.fn(async () => ({ data: {} })) };
      const resource = defineResource({
        name: "invoice",
        disableDefaultRoutes: true,
        controller: controller as never,
        permissions: authenticated(),
        disabledRoutes: ["list", "get", "update", "delete"],
      });
      const tools = resourceToTools(resource, {
        wiring: {
          idempotencyStore: store,
          idempotencyLockTimeoutMs: lockMs,
          idempotencyTtlMs: ttlMs,
        },
      });
      await tools[0]?.handler(
        { _idempotencyKey: "timing" },
        { session: { userId: "u" }, log: async () => {}, extra: {} },
      );
      expect(lock.mock.calls[0]?.[2]).toBe(expectedLock);
      const result = completion.mock.calls[0]?.[2];
      if (!result) throw new Error("Completion was not recorded");
      expect(result.expiresAt.getTime() - result.createdAt.getTime()).toBe(expectedTtl);
    },
  );
  it.each([
    [
      "organization",
      { userId: "u", organizationId: "org-a" },
      { userId: "u", organizationId: "org-b" },
    ],
    [
      "team",
      { userId: "u", organizationId: "org-a", teamId: "a" },
      { userId: "u", organizationId: "org-a", teamId: "b" },
    ],
    [
      "custom context",
      { userId: "u", organizationId: "org-a", context: { branchId: "a" } },
      { userId: "u", organizationId: "org-a", context: { branchId: "b" } },
    ],
    [
      "service principal",
      { userId: "u", clientId: "a", organizationId: "org-a" },
      { userId: "u", clientId: "b", organizationId: "org-a" },
    ],
  ])("isolates the same operation key by %s", async (_name, firstSession, secondSession) => {
    const store = new MemoryIdempotencyStore();
    const dispatch = vi.fn(async () => ({
      content: [{ type: "text", text: String(dispatch.mock.calls.length) }],
    }));
    const args = {
      store,
      key: "k",
      resourceName: "invoice",
      operation: "create",
      input: { amount: 10 },
      dispatch,
    };
    const first = await runIdempotentTool({
      ...args,
      session: firstSession,
    });
    const second = await runIdempotentTool({
      ...args,
      session: secondSession,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(first).not.toEqual(second);
  });
  it("refuses to store success after losing the completion lease", async () => {
    const store = new MemoryIdempotencyStore();
    const complete = vi.fn(async () => false);
    Object.defineProperty(store, "setIfLocked", { value: complete });
    const result = await runIdempotentTool({
      store,
      key: "lost",
      resourceName: "invoice",
      operation: "pay",
      input: {},
      session: { userId: "u" },
      dispatch: async () => ({ content: [{ type: "text", text: "paid" }] }),
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({ status: 409 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await store.findByPrefix("lost:")).toBeUndefined();
  });
  it.each(["missing", "unsupported"])(
    "refuses %s completion fencing before dispatch",
    async (mode) => {
      const store = new MemoryIdempotencyStore();
      Object.defineProperty(
        store,
        mode === "missing" ? "setIfLocked" : "supportsFencedCompletion",
        { value: mode === "missing" ? undefined : false },
      );
      const dispatch = vi.fn(async () => ({ content: [{ type: "text", text: "paid" }] }));
      const result = await runIdempotentTool({
        store,
        key: "legacy",
        resourceName: "invoice",
        operation: "pay",
        input: {},
        session: { userId: "u" },
        dispatch,
      });
      expect(result.isError).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
  it("requires an explicit migration escape at standalone tool generation", () => {
    const store = new MemoryIdempotencyStore();
    Object.defineProperty(store, "setIfLocked", { value: undefined });
    const controller = { create: vi.fn(async () => ({ data: {} })) };
    const resource = defineResource({
      name: "invoice",
      disableDefaultRoutes: true,
      controller: controller as never,
      permissions: authenticated(),
      disabledRoutes: ["list", "get", "update", "delete"],
    });
    expect(() => resourceToTools(resource, { wiring: { idempotencyStore: store } })).toThrow(
      /setIfLocked/,
    );
  });

  it("warns and propagates an explicitly allowed unfenced migration store", async () => {
    const store = new MemoryIdempotencyStore();
    Object.defineProperty(store, "setIfLocked", { value: undefined });
    const warn = vi.fn();
    const controller = { create: vi.fn(async () => ({ data: { paid: true } })) };
    const resource = defineResource({
      name: "invoice",
      disableDefaultRoutes: true,
      controller: controller as never,
      permissions: authenticated(),
      disabledRoutes: ["list", "get", "update", "delete"],
    });
    const tools = resourceToTools(resource, {
      wiring: { idempotencyStore: store, allowUnfencedCompletion: true, log: { warn } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("allowUnfencedCompletion"));
    const ctx = { session: { userId: "u" }, log: async () => {}, extra: {} };
    const first = await tools[0]?.handler({ _idempotencyKey: "migration" }, ctx);
    const retry = await tools[0]?.handler({ _idempotencyKey: "migration" }, ctx);
    expect(first?.isError).toBeFalsy();
    expect(retry).toEqual(first);
    expect(controller.create).toHaveBeenCalledTimes(1);
  });
});
