/**
 * Agent-auth permission helpers — requireDPoP, requireMandate, requireAgentScope
 *
 * Covers the 2.13 enterprise-auth shipment for AI-agent flows:
 * - Sender-constrained credentials via DPoP (RFC 9449)
 * - Capability mandates (AP2 / Stripe x402 / MCP authorization)
 */

import { describe, expect, it } from "vitest";
import { requireAgentScope, requireDPoP, requireMandate } from "../../src/permissions/agent.js";
import {
  makeAuthenticatedCtx,
  makeElevatedCtx,
  makeMemberCtx,
  makePublicCtx,
  makeServiceCtx,
} from "../_helpers/scope-factories.js";

// ============================================================================
// requireDPoP()
// ============================================================================

describe("requireDPoP()", () => {
  const check = requireDPoP();

  it("grants service scope with dpopJkt set", async () => {
    const result = await check(makeServiceCtx({ dpopJkt: "abc123" }));
    expect(result).toBe(true);
  });

  it("denies service scope without dpopJkt", async () => {
    const result = await check(makeServiceCtx({}));
    expect(result).toMatchObject({ granted: false });
  });

  it("denies member scope (humans don't carry DPoP)", async () => {
    const result = await check(makeMemberCtx({}));
    expect(result).toMatchObject({ granted: false });
  });

  it("denies public scope", async () => {
    const result = await check(makePublicCtx());
    expect(result).toMatchObject({ granted: false });
  });

  it("grants elevated scope (platform admin bypass)", async () => {
    const result = await check(makeElevatedCtx({}));
    expect(result).toBe(true);
  });

  it("tags _dpopRequired metadata", () => {
    expect(check._dpopRequired).toBe(true);
  });
});

// ============================================================================
// requireMandate()
// ============================================================================

describe("requireMandate(capability, opts?)", () => {
  it("throws synchronously when constructed with empty capability", () => {
    expect(() => requireMandate("")).toThrow(/non-empty capability/);
  });

  it("grants when mandate's capability matches", async () => {
    const check = requireMandate("payment.charge");
    const result = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge" },
      }),
    );
    expect(result).toBe(true);
  });

  it("denies when capability mismatches", async () => {
    const check = requireMandate("payment.charge");
    const result = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "data.export" },
      }),
    );
    expect(result).toMatchObject({
      granted: false,
      reason: expect.stringContaining("data.export"),
    });
  });

  it("denies when no mandate is present", async () => {
    const check = requireMandate("payment.charge");
    const result = await check(makeServiceCtx({}));
    expect(result).toMatchObject({ granted: false });
  });

  it("denies when mandate has expired (past grace window)", async () => {
    const check = requireMandate("payment.charge", { ttlGraceMs: 0 });
    const result = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge", expiresAt: Date.now() - 1000 },
      }),
    );
    expect(result).toMatchObject({
      granted: false,
      reason: expect.stringContaining("expired"),
    });
  });

  it("grants when mandate is within grace window", async () => {
    const check = requireMandate("payment.charge", { ttlGraceMs: 60_000 });
    const result = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge", expiresAt: Date.now() - 5_000 },
      }),
    );
    expect(result).toBe(true);
  });

  it("validates audience binding when configured (static)", async () => {
    const check = requireMandate("payment.charge", { audience: "invoice:INV-7" });
    const ok = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge", audience: "invoice:INV-7" },
      }),
    );
    expect(ok).toBe(true);

    const denied = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge", audience: "invoice:INV-99" },
      }),
    );
    expect(denied).toMatchObject({ granted: false });
  });

  it("validates audience binding via function extractor", async () => {
    const check = requireMandate("payment.charge", {
      audience: (ctx) =>
        `invoice:${(ctx.request as unknown as { params?: { id?: string } }).params?.id}`,
    });
    const ok = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge", audience: "invoice:INV-7" },
        params: { id: "INV-7" },
      }),
    );
    expect(ok).toBe(true);
  });

  it("denies when audience is required but mandate has none", async () => {
    const check = requireMandate("payment.charge", { audience: "invoice:INV-7" });
    const result = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge" }, // no audience
      }),
    );
    expect(result).toMatchObject({ granted: false });
  });

  it("invokes validateAmount and respects deny + custom reason", async () => {
    const check = requireMandate<{ amount: number }>("payment.charge", {
      validateAmount: (ctx, mandate) => {
        const amount = (ctx.data as { amount?: number })?.amount ?? 0;
        if (amount <= (mandate.cap ?? 0)) return true;
        return `Amount ${amount} exceeds cap ${mandate.cap}`;
      },
    });
    const ctx = makeServiceCtx<{ amount: number }>({
      mandate: { id: "m1", capability: "payment.charge", cap: 100, currency: "USD" },
      body: { amount: 200 },
    });
    // PermissionContext.data is sourced from body in our factory shape:
    (ctx as unknown as { data: { amount: number } }).data = { amount: 200 };
    const result = await check(ctx);
    expect(result).toMatchObject({
      granted: false,
      reason: "Amount 200 exceeds cap 100",
    });
  });

  it("elevated scope bypasses mandate check by default", async () => {
    const check = requireMandate("payment.charge");
    expect(await check(makeElevatedCtx({}))).toBe(true);
  });

  it("noElevatedBypass: true forces elevated through the check", async () => {
    const check = requireMandate("payment.charge", { noElevatedBypass: true });
    const result = await check(makeElevatedCtx({}));
    expect(result).toMatchObject({ granted: false });
  });

  it("tags _mandateCapability metadata", () => {
    const check = requireMandate("payment.charge");
    expect(check._mandateCapability).toBe("payment.charge");
  });
});

// ============================================================================
// requireAgentScope() — composite gate
// ============================================================================

describe("requireAgentScope({ capability, scopes, requireDPoP })", () => {
  it("requires capability", () => {
    expect(() => requireAgentScope({} as { capability: string })).toThrow();
  });

  it("grants when service has scopes + mandate + DPoP", async () => {
    const check = requireAgentScope({
      capability: "payment.charge",
      scopes: ["payment.write"],
    });
    const result = await check(
      makeServiceCtx({
        scopes: ["payment.write"],
        mandate: { id: "m1", capability: "payment.charge" },
        dpopJkt: "key-fp",
      }),
    );
    expect(result).toBe(true);
  });

  it("denies when OAuth scope is missing", async () => {
    const check = requireAgentScope({
      capability: "payment.charge",
      scopes: ["payment.write"],
    });
    const result = await check(
      makeServiceCtx({
        scopes: ["other.read"],
        mandate: { id: "m1", capability: "payment.charge" },
        dpopJkt: "key-fp",
      }),
    );
    expect(result).toMatchObject({
      granted: false,
      reason: expect.stringContaining("payment.write"),
    });
  });

  it("denies when DPoP missing (default requireDPoP: true)", async () => {
    const check = requireAgentScope({ capability: "payment.charge" });
    const result = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "payment.charge" },
      }),
    );
    expect(result).toMatchObject({ granted: false });
  });

  it("allows opting out of DPoP", async () => {
    const check = requireAgentScope({
      capability: "data.export",
      requireDPoP: false,
    });
    const result = await check(
      makeServiceCtx({
        mandate: { id: "m1", capability: "data.export" },
      }),
    );
    expect(result).toBe(true);
  });

  it("denies non-service scopes", async () => {
    const check = requireAgentScope({ capability: "payment.charge", requireDPoP: false });
    expect(await check(makeMemberCtx({}))).toMatchObject({ granted: false });
    expect(await check(makeAuthenticatedCtx({}))).toMatchObject({ granted: false });
    expect(await check(makePublicCtx())).toMatchObject({ granted: false });
  });

  it("elevated bypasses the whole composite by default", async () => {
    const check = requireAgentScope({ capability: "payment.charge" });
    expect(await check(makeElevatedCtx({}))).toBe(true);
  });

  it("tags _agentScope metadata for downstream introspection", () => {
    const check = requireAgentScope({
      capability: "payment.charge",
      scopes: ["payment.write"],
    });
    expect(check._agentScope).toEqual({
      capability: "payment.charge",
      scopes: ["payment.write"],
      dpop: true,
    });
  });
});
