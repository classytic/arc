/**
 * websocket/auth.ts — unit tests for the unified auth helper.
 *
 * This module is the crown jewel of the v2.11 websocket split: it collapses
 * two previously-duplicated `fakeReply` shims (one in the handshake path,
 * one in the re-auth loop) into a single boundary. Regressions here are
 * security-adjacent, so the tests cover the rejection surface end-to-end.
 */

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateWebSocket,
  createCaptureReply,
} from "../../src/integrations/websocket/auth.js";

// ============================================================================
// createCaptureReply
// ============================================================================

describe("createCaptureReply", () => {
  it("starts un-rejected with no captured status", () => {
    const reply = createCaptureReply();
    expect(reply.rejected).toBe(false);
    expect(reply.statusCode).toBeUndefined();
    expect(reply.sent).toBe(false);
  });

  it("code(n) flips rejected + captures status and returns the reply (chainable)", () => {
    const reply = createCaptureReply();
    const chained = reply.code(401);
    expect(chained).toBe(reply);
    expect(reply.rejected).toBe(true);
    expect(reply.statusCode).toBe(401);
  });

  it("send() is a no-op chainable — never 'actually' sends (we're in a WS upgrade)", () => {
    const reply = createCaptureReply();
    const chained = reply.code(403).send();
    expect(chained).toBe(reply);
    expect(reply.rejected).toBe(true);
  });

  it("captures the FIRST code() call — subsequent calls don't overwrite the signal", () => {
    // Most @fastify/jwt style flows call `.code(401).send()` exactly once.
    // If an auth impl calls code twice (unusual) we still flag rejected.
    const reply = createCaptureReply();
    reply.code(401);
    reply.code(500);
    expect(reply.rejected).toBe(true);
    // We don't specify whether 401 or 500 wins — tests shouldn't depend on it.
  });
});

// ============================================================================
// authenticateWebSocket — customAuth path
// ============================================================================

describe("authenticateWebSocket — customAuth", () => {
  it("returns the customAuth result verbatim on success", async () => {
    const customAuth = vi.fn(async () => ({ userId: "u1", organizationId: "org-1" }));
    const fastify = {} as FastifyInstance;

    const result = await authenticateWebSocket(fastify, { mock: "request" }, customAuth);

    expect(result).toEqual({ userId: "u1", organizationId: "org-1" });
    expect(customAuth).toHaveBeenCalledWith({ mock: "request" });
  });

  it("returns null when customAuth returns null (denied)", async () => {
    const customAuth = vi.fn(async () => null);
    const fastify = {} as FastifyInstance;
    const result = await authenticateWebSocket(fastify, {}, customAuth);
    expect(result).toBeNull();
  });

  it("returns null when customAuth throws (fail-closed)", async () => {
    const customAuth = vi.fn(async () => {
      throw new Error("upstream auth service unreachable");
    });
    const fastify = {} as FastifyInstance;
    const result = await authenticateWebSocket(fastify, {}, customAuth);
    expect(result).toBeNull();
  });

  it("preserves service-account fields (clientId + scopes)", async () => {
    const customAuth = vi.fn(async () => ({
      clientId: "svc-bot-1",
      scopes: ["read", "write"] as const,
    }));
    const fastify = {} as FastifyInstance;
    const result = await authenticateWebSocket(fastify, {}, customAuth);
    expect(result).toEqual({ clientId: "svc-bot-1", scopes: ["read", "write"] });
  });
});

// ============================================================================
// authenticateWebSocket — fastify.authenticate path
// ============================================================================

describe("authenticateWebSocket — fastify.authenticate (default path)", () => {
  function makeFastifyWithAuth(
    impl: (request: unknown, reply: { code: (n: number) => unknown }) => Promise<void>,
  ): FastifyInstance {
    return { authenticate: impl } as unknown as FastifyInstance;
  }

  it("populates request.user/scope → returns { userId, organizationId }", async () => {
    const request: Record<string, unknown> = {};
    const fastify = makeFastifyWithAuth(async (req) => {
      // Realistic @fastify/jwt behaviour: populate request.user.
      (req as Record<string, unknown>).user = { id: "u42", roles: ["admin"] };
      (req as Record<string, unknown>).scope = { organizationId: "org-xyz" };
    });

    const result = await authenticateWebSocket(fastify, request, undefined);

    expect(result).toEqual({ userId: "u42", organizationId: "org-xyz" });
  });

  it("falls back to user.sub when user.id is absent (JWT standard claim)", async () => {
    const request: Record<string, unknown> = {};
    const fastify = makeFastifyWithAuth(async (req) => {
      (req as Record<string, unknown>).user = { sub: "jwt-sub-id" };
    });

    const result = await authenticateWebSocket(fastify, request, undefined);
    expect(result?.userId).toBe("jwt-sub-id");
  });

  it("returns null when fastify.authenticate calls reply.code(401) — rejection signal", async () => {
    const request: Record<string, unknown> = {};
    const fastify = makeFastifyWithAuth(async (_req, reply) => {
      // Standard @fastify/jwt denial: reply.code(401).send(...)
      reply.code(401);
    });

    const result = await authenticateWebSocket(fastify, request, undefined);
    expect(result).toBeNull();
  });

  it("returns null when fastify.authenticate throws", async () => {
    const request: Record<string, unknown> = {};
    const fastify = makeFastifyWithAuth(async () => {
      throw new Error("token expired");
    });

    const result = await authenticateWebSocket(fastify, request, undefined);
    expect(result).toBeNull();
  });

  it("returns null when fastify.authenticate succeeds but request.user is absent", async () => {
    // Defensive: if the auth impl doesn't throw and doesn't reject via
    // reply.code BUT doesn't populate request.user either, we fail closed.
    const fastify = makeFastifyWithAuth(async () => {
      // no-op — doesn't set request.user
    });

    const result = await authenticateWebSocket(fastify, {}, undefined);
    expect(result).toBeNull();
  });

  it("returns null when fastify has no authenticate decorator (misconfiguration)", async () => {
    // Shouldn't reach here in practice — plugin-register time throws — but
    // the helper is defensive.
    const fastify = {} as FastifyInstance;
    const result = await authenticateWebSocket(fastify, {}, undefined);
    expect(result).toBeNull();
  });

  it("handles non-string id fields gracefully (e.g., ObjectId objects)", async () => {
    const request: Record<string, unknown> = {};
    const fastify = makeFastifyWithAuth(async (req) => {
      // Some auth impls set user.id to a Mongo ObjectId — not a string.
      (req as Record<string, unknown>).user = { id: { toString: () => "507f1f..." } };
    });

    const result = await authenticateWebSocket(fastify, request, undefined);
    // userId is typed as string | undefined; non-string fields become undefined.
    // The user is still authenticated (result is not null) — just without a userId.
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    expect(result?.userId).toBeUndefined();
  });
});

// ============================================================================
// authenticateWebSocket — reuse invariant (same helper for handshake + reauth)
// ============================================================================

describe("authenticateWebSocket — handshake/reauth parity", () => {
  it("calling the helper twice with the same inputs yields the same output", async () => {
    // Regression: pre-split the handshake and re-auth paths had separate
    // fakeReply shims. If one was hardened and the other drifted, the
    // plugin would admit + continue clients that an updated auth impl
    // would deny. The unified helper makes divergence impossible by
    // construction; this test locks the invariant.
    const customAuth = vi.fn(async () => ({ userId: "u1", organizationId: "org-1" }));
    const fastify = {} as FastifyInstance;

    const first = await authenticateWebSocket(fastify, { n: 1 }, customAuth);
    const second = await authenticateWebSocket(fastify, { n: 1 }, customAuth);

    expect(first).toEqual(second);
    expect(customAuth).toHaveBeenCalledTimes(2);
  });

  it("reauth-style: token revoked between calls → first succeeds, second rejects", async () => {
    let revoked = false;
    const customAuth = vi.fn(async () => (revoked ? null : { userId: "u1" }));
    const fastify = {} as FastifyInstance;

    const first = await authenticateWebSocket(fastify, {}, customAuth);
    expect(first).toEqual({ userId: "u1" });

    revoked = true;
    const second = await authenticateWebSocket(fastify, {}, customAuth);
    expect(second).toBeNull();
  });
});
