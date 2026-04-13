/**
 * Export smoke test — verifies every public subpath resolves and key symbols
 * are accessible at their documented import paths.
 *
 * Runs against the built dist/ (not source), so it catches:
 * - Missing barrel re-exports
 * - tsdown entry point misconfigurations
 * - Symbols that exist in source but aren't in the published package
 *
 * This test should be run AFTER `npm run build`.
 */

import { describe, expect, it } from "vitest";

// ============================================================================
// Subpath resolution — every package.json "exports" entry must resolve
// ============================================================================

describe("Subpath resolution", () => {
  const subpaths = [
    "@classytic/arc",
    "@classytic/arc/utils",
    "@classytic/arc/permissions",
    "@classytic/arc/events",
    "@classytic/arc/core",
    "@classytic/arc/types",
    "@classytic/arc/cache",
    "@classytic/arc/hooks",
    "@classytic/arc/plugins",
    "@classytic/arc/factory",
    "@classytic/arc/auth",
    "@classytic/arc/idempotency",
    "@classytic/arc/policies",
    "@classytic/arc/scope",
    "@classytic/arc/adapters",
    "@classytic/arc/registry",
    "@classytic/arc/presets",
    "@classytic/arc/schemas",
    "@classytic/arc/docs",
    "@classytic/arc/rpc",
    "@classytic/arc/org",
    "@classytic/arc/dynamic",
    "@classytic/arc/discovery",
    "@classytic/arc/audit",
    "@classytic/arc/plugins/response-cache",
    "@classytic/arc/mcp",
  ];

  for (const path of subpaths) {
    it(`resolves: ${path}`, async () => {
      const mod = await import(path);
      expect(mod).toBeDefined();
      expect(typeof mod).toBe("object");
    });
  }
});

// ============================================================================
// Key symbol availability — the most-imported symbols from each subpath
// ============================================================================

describe("Key symbols from root (@classytic/arc)", () => {
  it("exports defineResource, BaseController (createApp is on /factory)", async () => {
    const mod = await import("@classytic/arc");
    expect(typeof mod.defineResource).toBe("function");
    expect(typeof mod.BaseController).toBe("function");
  });

  it("exports error classes", async () => {
    const mod = await import("@classytic/arc");
    expect(typeof mod.ArcError).toBe("function");
    expect(typeof mod.ForbiddenError).toBe("function");
    expect(typeof mod.NotFoundError).toBe("function");
    expect(typeof mod.ValidationError).toBe("function");
    expect(typeof mod.UnauthorizedError).toBe("function");
    expect(typeof mod.createDomainError).toBe("function");
  });

  it("handleRaw is NOT on root (tree-shaking — use @classytic/arc/utils)", async () => {
    const mod = await import("@classytic/arc");
    expect((mod as Record<string, unknown>).handleRaw).toBeUndefined();
  });
});

describe("Key symbols from @classytic/arc/utils", () => {
  it("exports handleRaw, createDomainError, error classes", async () => {
    const mod = await import("@classytic/arc/utils");
    expect(typeof mod.handleRaw).toBe("function");
    expect(typeof mod.createDomainError).toBe("function");
    expect(typeof mod.ArcError).toBe("function");
    expect(typeof mod.ForbiddenError).toBe("function");
    expect(typeof mod.createStateMachine).toBe("function");
    expect(typeof mod.CircuitBreaker).toBe("function");
  });
});

describe("Key symbols from @classytic/arc/core", () => {
  it("exports defineResource, BaseController, buildActionBodySchema", async () => {
    const mod = await import("@classytic/arc/core");
    expect(typeof mod.defineResource).toBe("function");
    expect(typeof mod.BaseController).toBe("function");
    expect(typeof mod.buildActionBodySchema).toBe("function");
    expect(typeof mod.createActionRouter).toBe("function");
  });
});

describe("Key symbols from @classytic/arc/events", () => {
  it("exports EventOutbox, MemoryOutboxStore, outbox errors, retry helper", async () => {
    const mod = await import("@classytic/arc/events");
    expect(typeof mod.EventOutbox).toBe("function");
    expect(typeof mod.MemoryOutboxStore).toBe("function");
    expect(typeof mod.MemoryEventTransport).toBe("function");
    expect(typeof mod.OutboxOwnershipError).toBe("function");
    expect(typeof mod.InvalidOutboxEventError).toBe("function");
    expect(typeof mod.exponentialBackoff).toBe("function");
    expect(typeof mod.eventPlugin).toBe("function");
  });
});

describe("Key symbols from @classytic/arc/permissions", () => {
  it("exports permission helpers", async () => {
    const mod = await import("@classytic/arc/permissions");
    expect(typeof mod.allowPublic).toBe("function");
    expect(typeof mod.requireAuth).toBe("function");
    expect(typeof mod.requireRoles).toBe("function");
  });
});

describe("Key symbols from @classytic/arc/idempotency", () => {
  it("exports idempotencyPlugin and MemoryIdempotencyStore", async () => {
    const mod = await import("@classytic/arc/idempotency");
    expect(typeof mod.idempotencyPlugin).toBe("function");
    expect(typeof mod.MemoryIdempotencyStore).toBe("function");
  });
});

describe("Key symbols from @classytic/arc/scope", () => {
  it("exports scope helpers", async () => {
    const mod = await import("@classytic/arc/scope");
    expect(typeof mod.getRequestScope).toBe("function");
    expect(typeof mod.getUserId).toBe("function");
    expect(typeof mod.isMember).toBe("function");
  });
});

describe("Key symbols from @classytic/arc/factory", () => {
  it("exports createApp", async () => {
    const mod = await import("@classytic/arc/factory");
    expect(typeof mod.createApp).toBe("function");
  });
});

// ============================================================================
// Publish-path sanity — dist/ artifacts are valid JS, not raw TS
// ============================================================================

describe("Publish-path sanity (dist/ artifacts)", () => {
  it("dist/index.mjs is loadable and exports defineResource", async () => {
    // Import directly from the dist path to prove the transpiled artifact
    // is valid JS. If tsdown misconfigures or a TS-only construct leaks
    // through (type-only import emitted as runtime, const enum, etc.),
    // this will throw a SyntaxError or ReferenceError.
    const mod = await import("../../dist/index.mjs");
    expect(typeof mod.defineResource).toBe("function");
  });

  it("dist/utils/index.mjs exports handleRaw", async () => {
    const mod = await import("../../dist/utils/index.mjs");
    expect(typeof mod.handleRaw).toBe("function");
    expect(typeof mod.ArcError).toBe("function");
  });

  it("dist/events/index.mjs exports EventOutbox", async () => {
    const mod = await import("../../dist/events/index.mjs");
    expect(typeof mod.EventOutbox).toBe("function");
    expect(typeof mod.exponentialBackoff).toBe("function");
  });

  it("dist/core/index.mjs exports buildActionBodySchema", async () => {
    const mod = await import("../../dist/core/index.mjs");
    expect(typeof mod.buildActionBodySchema).toBe("function");
  });

  it("dist/ .d.mts files exist for type checking", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dist = resolve(import.meta.dirname, "../../dist");

    expect(existsSync(`${dist}/index.d.mts`)).toBe(true);
    expect(existsSync(`${dist}/utils/index.d.mts`)).toBe(true);
    expect(existsSync(`${dist}/events/index.d.mts`)).toBe(true);
    expect(existsSync(`${dist}/core/index.d.mts`)).toBe(true);
  });
});
