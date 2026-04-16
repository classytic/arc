/**
 * Security Tests: Elevation emits audit event unconditionally
 *
 * `x-arc-scope: platform` grants a superadmin access to every
 * organisation's data. Previously `onElevation` was optional and the
 * only audit trail — apps that forgot to wire it had silent
 * privilege escalation.
 *
 * Elevation now publishes `arc.scope.elevated` on `fastify.events` on
 * every successful elevation. Apps that use `onElevation` still see the
 * callback; apps that don't still see the event.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";

describe("Security: Elevation audit event", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("emits arc.scope.elevated on every successful elevation", async () => {
    const events: Array<Record<string, unknown>> = [];

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.events.subscribe("arc.scope.elevated", async (evt) => {
          events.push(evt.payload as Record<string, unknown>);
        });

        fastify.get("/items", { preHandler: [fastify.authenticate] }, async () => ({ ok: true }));
      },
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "admin-1", role: ["superadmin"] }).accessToken;

    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        authorization: `Bearer ${token}`,
        "x-arc-scope": "platform",
        "x-organization-id": "org-xyz",
      },
    });

    expect(res.statusCode).toBe(200);

    // Event delivery is async; give the transport a microtask to flush.
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: "admin-1",
      organizationId: "org-xyz",
      method: "GET",
    });
    expect(events[0]?.requestId).toBeTruthy();
    expect(events[0]?.timestamp).toBeTruthy();
  });

  it("does NOT emit the event when elevation is rejected (wrong role)", async () => {
    const events: Array<Record<string, unknown>> = [];

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.events.subscribe("arc.scope.elevated", async (evt) => {
          events.push(evt.payload as Record<string, unknown>);
        });
        fastify.get("/items", { preHandler: [fastify.authenticate] }, async () => ({ ok: true }));
      },
    });
    await app.ready();

    // Regular user — not superadmin.
    const token = app.auth.issueTokens({ id: "user-1", role: ["user"] }).accessToken;

    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        authorization: `Bearer ${token}`,
        "x-arc-scope": "platform",
      },
    });

    expect(res.statusCode).toBe(403);
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);
  });

  it("event is emitted even when onElevation callback is absent", async () => {
    // The prior code fired audit only via onElevation, so apps that skipped
    // it had no audit trail. The event now provides the floor.
    const events: Array<Record<string, unknown>> = [];

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] /* no onElevation */ },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.events.subscribe("arc.scope.elevated", async (evt) => {
          events.push(evt.payload as Record<string, unknown>);
        });
        fastify.get("/items", { preHandler: [fastify.authenticate] }, async () => ({ ok: true }));
      },
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "admin-1", role: ["superadmin"] }).accessToken;

    await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        authorization: `Bearer ${token}`,
        "x-arc-scope": "platform",
      },
    });

    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
  });

  it("payload shape is stable — every documented field is present with correct type", async () => {
    // Schema-drift gate: downstream SIEM / audit consumers rely on every
    // documented field. A silent rename (e.g. `requestId` → `reqId`) would
    // only surface in production — this assertion pins the contract.
    const events: Array<Record<string, unknown>> = [];

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.events.subscribe("arc.scope.elevated", async (evt) => {
          events.push(evt.payload as Record<string, unknown>);
        });
        fastify.post("/items", { preHandler: [fastify.authenticate] }, async () => ({ ok: true }));
      },
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "admin-42", role: ["superadmin"] }).accessToken;

    await app.inject({
      method: "POST",
      url: "/items",
      headers: {
        authorization: `Bearer ${token}`,
        "x-arc-scope": "platform",
        "x-organization-id": "org-abc",
      },
      payload: {},
    });

    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);

    const evt = events[0] as Record<string, unknown>;
    expect(typeof evt.userId).toBe("string");
    expect(evt.userId).toBe("admin-42");
    expect(typeof evt.organizationId).toBe("string");
    expect(evt.organizationId).toBe("org-abc");
    expect(typeof evt.method).toBe("string");
    expect(evt.method).toBe("POST");
    expect(typeof evt.requestId).toBe("string");
    expect((evt.requestId as string).length).toBeGreaterThan(0);
    expect(typeof evt.timestamp).toBe("string");
    // Timestamp must be a parseable ISO date string.
    expect(Number.isNaN(Date.parse(evt.timestamp as string))).toBe(false);
  });

  it("emits one event per elevation — sequential requests produce two distinct entries", async () => {
    const events: Array<Record<string, unknown>> = [];

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.events.subscribe("arc.scope.elevated", async (evt) => {
          events.push(evt.payload as Record<string, unknown>);
        });
        fastify.get("/items", { preHandler: [fastify.authenticate] }, async () => ({ ok: true }));
      },
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "admin-1", role: ["superadmin"] }).accessToken;
    const headers = {
      authorization: `Bearer ${token}`,
      "x-arc-scope": "platform",
      "x-organization-id": "org-xyz",
    };

    await app.inject({ method: "GET", url: "/items", headers });
    await app.inject({ method: "GET", url: "/items", headers });

    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(2);
    expect(events[0]?.requestId).not.toBe(events[1]?.requestId);
  });
});
