/**
 * Better Auth API-key → MCP auth resolver.
 *
 * Pins:
 *   - Header extraction precedence (Authorization Bearer → x-api-key).
 *   - referenceId → userId fallback.
 *   - metadata.organizationId extraction (default + custom field + function form).
 *   - Disabled / expired keys → null (fail-closed).
 *   - verifyApiKey throw → null (no propagation).
 *   - Throws at construction when auth instance lacks verifyApiKey.
 */

import { describe, expect, it, vi } from "vitest";
import { createMcpAuthFromBetterAuthApiKey } from "../../../src/integrations/mcp/betterAuthApiKey.js";
import type { BetterAuthHandler } from "../../../src/integrations/mcp/types.js";

interface VerifyResult {
  valid: boolean;
  key?: {
    id?: string;
    userId?: string;
    referenceId?: string;
    metadata?: unknown;
    permissions?: unknown;
    expiresAt?: string | Date | null;
    disabled?: boolean;
  } | null;
}

function makeAuth(verify: (opts: { body: { key: string } }) => Promise<VerifyResult | null>) {
  return {
    api: { verifyApiKey: vi.fn(verify), getMcpSession: vi.fn() },
    handler: vi.fn(),
  } as unknown as BetterAuthHandler;
}

describe("createMcpAuthFromBetterAuthApiKey", () => {
  it("throws at construction when verifyApiKey is missing", () => {
    const auth = {
      api: { getMcpSession: vi.fn() },
      handler: vi.fn(),
    } as unknown as BetterAuthHandler;
    expect(() => createMcpAuthFromBetterAuthApiKey(auth)).toThrow(/verifyApiKey/);
  });

  it("returns null when no api key header is present", async () => {
    const resolver = createMcpAuthFromBetterAuthApiKey(makeAuth(async () => ({ valid: true })));
    await expect(resolver({})).resolves.toBeNull();
  });

  it("extracts Bearer token from Authorization header", async () => {
    let seen: string | undefined;
    const auth = makeAuth(async ({ body }) => {
      seen = body.key;
      return { valid: true, key: { userId: "u1", metadata: { organizationId: "o1" } } };
    });
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    const out = await resolver({ authorization: "Bearer abc123" });
    expect(seen).toBe("abc123");
    expect(out).toEqual({ userId: "u1", organizationId: "o1" });
  });

  it("falls back to x-api-key header when Authorization is absent", async () => {
    let seen: string | undefined;
    const auth = makeAuth(async ({ body }) => {
      seen = body.key;
      return { valid: true, key: { userId: "u1" } };
    });
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    await resolver({ "x-api-key": "secret-key" });
    expect(seen).toBe("secret-key");
  });

  it("falls back to key.referenceId when userId is absent", async () => {
    const auth = makeAuth(async () => ({ valid: true, key: { referenceId: "u-ref" } }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    const out = await resolver({ "x-api-key": "k" });
    expect(out?.userId).toBe("u-ref");
  });

  it("treats keys with neither userId nor referenceId as service principals (clientId)", async () => {
    const auth = makeAuth(async () => ({ valid: true, key: { id: "key_abc" } }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    const out = await resolver({ "x-api-key": "k" });
    expect(out).toEqual({ clientId: "key_abc" });
  });

  it("parses JSON-stringified metadata", async () => {
    const auth = makeAuth(async () => ({
      valid: true,
      key: { userId: "u1", metadata: JSON.stringify({ organizationId: "org-json" }) },
    }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    const out = await resolver({ "x-api-key": "k" });
    expect(out?.organizationId).toBe("org-json");
  });

  it("supports a custom metadataOrgField", async () => {
    const auth = makeAuth(async () => ({
      valid: true,
      key: { userId: "u1", metadata: { tenantId: "tenant-1" } },
    }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth, { metadataOrgField: "tenantId" });
    const out = await resolver({ "x-api-key": "k" });
    expect(out?.organizationId).toBe("tenant-1");
  });

  it("supports a function-form orgFromMetadata extractor", async () => {
    const auth = makeAuth(async () => ({
      valid: true,
      key: { userId: "u1", metadata: { workspace: { id: "ws-1" } } },
    }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth, {
      orgFromMetadata: (meta) => (meta as { workspace?: { id?: string } })?.workspace?.id,
    });
    const out = await resolver({ "x-api-key": "k" });
    expect(out?.organizationId).toBe("ws-1");
  });

  it("omits organizationId when orgFromMetadata is false", async () => {
    const auth = makeAuth(async () => ({
      valid: true,
      key: { userId: "u1", metadata: { organizationId: "ignored" } },
    }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth, { orgFromMetadata: false });
    const out = await resolver({ "x-api-key": "k" });
    expect(out?.organizationId).toBeUndefined();
  });

  it("returns null for disabled keys", async () => {
    const auth = makeAuth(async () => ({
      valid: true,
      key: { userId: "u1", disabled: true },
    }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    await expect(resolver({ "x-api-key": "k" })).resolves.toBeNull();
  });

  it("returns null for expired keys", async () => {
    const auth = makeAuth(async () => ({
      valid: true,
      key: { userId: "u1", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    await expect(resolver({ "x-api-key": "k" })).resolves.toBeNull();
  });

  it("returns null when verifyApiKey throws (no propagation)", async () => {
    const auth = makeAuth(async () => {
      throw new Error("db down");
    });
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    await expect(resolver({ "x-api-key": "k" })).resolves.toBeNull();
  });

  it("flattens permissions[mcp] into scopes", async () => {
    const auth = makeAuth(async () => ({
      valid: true,
      key: { userId: "u1", permissions: { mcp: ["read:posts", "write:posts"] } },
    }));
    const resolver = createMcpAuthFromBetterAuthApiKey(auth);
    const out = await resolver({ "x-api-key": "k" });
    expect(out?.scopes).toEqual(["read:posts", "write:posts"]);
  });
});
