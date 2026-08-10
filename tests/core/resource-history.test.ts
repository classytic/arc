/**
 * `history: true` (2.22) — the per-record change timeline shorthand.
 *
 * Pins the Phase-0 expansion contract: the flag is CONSUMED into
 * `audit: true` + a `GET /:id/history` route; permission default chain
 * (explicit → update → get → requireAuth); explicit audit config
 * survives; and the injected handler's behavior (503 without the audit
 * decoration, paged audit query with it).
 */
import { describe, expect, it, vi } from "vitest";
import { normalizeResourceConfig } from "../../src/core/defineResource/normalizeConfig.js";
import type { ResourceConfig, RouteDefinition } from "../../src/types/index.js";

function historyRouteOf(config: ResourceConfig): RouteDefinition {
  const normalized = normalizeResourceConfig(config);
  const route = (normalized.routes ?? []).find((r) => r.path === "/:id/history");
  expect(route).toBeDefined();
  return route as RouteDefinition;
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return reply;
}

describe("history: true — Phase-0 expansion", () => {
  it("injects the route, implies audit, and consumes the flag", () => {
    const normalized = normalizeResourceConfig({ name: "order", history: true });
    expect(normalized.audit).toBe(true);
    expect(normalized.history).toBeUndefined();
    expect((normalized.routes ?? []).some((r) => r.path === "/:id/history")).toBe(true);
  });

  it("preserves explicit audit config and existing routes", () => {
    const custom: RouteDefinition = {
      method: "POST",
      path: "/custom",
      permissions: () => true,
      handler: async () => ({ success: true }),
    };
    const normalized = normalizeResourceConfig({
      name: "order",
      history: true,
      audit: { operations: ["delete"] },
      routes: [custom],
    });
    expect(normalized.audit).toEqual({ operations: ["delete"] });
    expect(normalized.routes).toHaveLength(2);
    expect(normalized.routes?.[0]?.path).toBe("/custom");
  });

  it("permission gate: explicit > update > get", () => {
    const explicit = () => true;
    const update = () => true;
    const get = () => true;

    expect(
      historyRouteOf({
        name: "a",
        history: { permissions: explicit },
        permissions: { update, get },
      }).permissions,
    ).toBe(explicit);
    expect(
      historyRouteOf({ name: "b", history: true, permissions: { update, get } }).permissions,
    ).toBe(update);
    expect(historyRouteOf({ name: "c", history: true, permissions: { get } }).permissions).toBe(
      get,
    );
    // No derivable gate → requireAuth() fallback (a function, not undefined)
    expect(typeof historyRouteOf({ name: "d", history: true }).permissions).toBe("function");
  });

  it("handler answers 503 when the audit decoration is missing or no-op", async () => {
    const route = historyRouteOf({ name: "order", history: true });
    const handler = (route.rawHandler ?? route.handler) as (
      req: unknown,
      reply: unknown,
    ) => Promise<unknown>;

    const noDecoration = fakeReply();
    await handler({ server: {}, params: { id: "x" }, query: {} }, noDecoration);
    expect(noDecoration.statusCode).toBe(503);
    expect((noDecoration.payload as { code: string }).code).toBe("history.audit_unavailable");

    const noop = fakeReply();
    await handler(
      { server: { audit: { query: async () => [], _noop: true } }, params: { id: "x" }, query: {} },
      noop,
    );
    expect(noop.statusCode).toBe(503);
  });

  it("handler pages the audit query for the one document", async () => {
    const query = vi.fn(async () => [{ action: "update" }]);
    const route = historyRouteOf({ name: "order", history: { limit: 25 } });
    const handler = (route.rawHandler ?? route.handler) as (
      req: unknown,
      reply: unknown,
    ) => Promise<unknown>;

    const reply = fakeReply();
    await handler(
      { server: { audit: { query } }, params: { id: "ord-1" }, query: { offset: "5" } },
      reply,
    );
    expect(query).toHaveBeenCalledWith({
      resource: "order",
      documentId: "ord-1",
      limit: 25,
      offset: 5,
    });
    expect(reply.payload).toEqual({ data: [{ action: "update" }], limit: 25, offset: 5 });
  });

  it("caps the wire limit at 200", async () => {
    const query = vi.fn(async () => []);
    const route = historyRouteOf({ name: "order", history: true });
    const handler = (route.rawHandler ?? route.handler) as (
      req: unknown,
      reply: unknown,
    ) => Promise<unknown>;
    await handler(
      { server: { audit: { query } }, params: { id: "x" }, query: { limit: "9999" } },
      fakeReply(),
    );
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });
});
