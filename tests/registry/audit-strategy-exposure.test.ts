/**
 * Audit-surface exposure of the full `TenantPurgeStrategy`.
 *
 * Pre-2.17, `getCascadingResourcesWithMetadata()`,
 * `assertNoTenantData()`'s `TenantDataLeak.strategy`, and
 * `PurgeResourceOutcome.strategy` all returned `TenantPurgeStrategy["type"]`
 * — the discriminant tag only. That dropped the audit-critical fields the
 * non-trivial variants carry:
 *   - `skip` MUST carry a `reason: string` (compliance sign-off forcing function)
 *   - `anonymize` carries a `fields` map
 *   - `custom` carries a handler descriptor
 *
 * Auditors couldn't answer "why was admin-org skipped?" without
 * re-reading the resource definitions. 2.17 returns the full
 * discriminated union so the `reason` (and fields / handler) flows
 * straight to the audit table.
 */

import { describe, expect, it } from "vitest";
import { allowPublic, defineResource } from "../../src/index.js";
import { getCascadingResourcesWithMetadata, ResourceRegistry } from "../../src/registry/index.js";
import { createMockRepositoryMock } from "../setup.js";

function mockAdapter(name: string) {
  return {
    type: "mock",
    name,
    repository: createMockRepositoryMock(),
    // biome-ignore lint/suspicious/noExplicitAny: adapter stub shape
  } as any;
}

describe("getCascadingResourcesWithMetadata — exposes full TenantPurgeStrategy", () => {
  it("preserves `reason` on skip-strategy entries", () => {
    const registry = new ResourceRegistry();

    registry.register(
      defineResource({
        name: "admin-org",
        adapter: mockAdapter("admin-org"),
        permissions: { list: allowPublic() },
        onTenantDelete: {
          strategy: { type: "skip", reason: "this resource is the org table itself" },
        },
      }),
    );

    registry.register(
      defineResource({
        name: "scheduled-post",
        adapter: mockAdapter("scheduled-post"),
        permissions: { list: allowPublic() },
        onTenantDelete: {
          strategy: { type: "skip", reason: "scheduled publishes must drain via worker" },
        },
      }),
    );

    const meta = getCascadingResourcesWithMetadata(registry);
    const adminOrg = meta.find((r) => r.name === "admin-org");
    const scheduledPost = meta.find((r) => r.name === "scheduled-post");

    // Both entries are present (skip is still "cascading" from the
    // audit-listing perspective — it's a declared exemption, not a no-op
    // miss). The full strategy is exposed so auditors see the reason.
    expect(adminOrg?.strategy).toEqual({
      type: "skip",
      reason: "this resource is the org table itself",
    });
    expect(scheduledPost?.strategy).toEqual({
      type: "skip",
      reason: "scheduled publishes must drain via worker",
    });
  });

  it("preserves the `fields` map on anonymize-strategy entries", () => {
    const registry = new ResourceRegistry();

    registry.register(
      defineResource({
        name: "audit-log",
        adapter: mockAdapter("audit-log"),
        permissions: { list: allowPublic() },
        onTenantDelete: {
          strategy: {
            type: "anonymize",
            fields: { email: null, ipAddress: "0.0.0.0" },
          },
        },
      }),
    );

    const meta = getCascadingResourcesWithMetadata(registry);
    const auditLog = meta.find((r) => r.name === "audit-log");

    expect(auditLog?.strategy).toEqual({
      type: "anonymize",
      fields: { email: null, ipAddress: "0.0.0.0" },
    });
  });

  it("hard-strategy entries still expose the discriminant cleanly", () => {
    const registry = new ResourceRegistry();

    registry.register(
      defineResource({
        name: "order",
        adapter: mockAdapter("order"),
        permissions: { list: allowPublic() },
        onTenantDelete: { strategy: { type: "hard" } },
      }),
    );

    const meta = getCascadingResourcesWithMetadata(registry);
    const order = meta.find((r) => r.name === "order");

    expect(order?.strategy).toEqual({ type: "hard" });
    // narrowing works — caller can branch on `.type`
    if (order?.strategy.type === "hard") {
      // intentional — this is the typed-access path auditors use
      expect(order.strategy.type).toBe("hard");
    }
  });
});
