/**
 * Unit tests for `autoInjectTenantFieldRules` — the shared helper that
 * `defineResource` uses to stamp `systemManaged: true` +
 * `preserveForElevated: true` on the tenant field's rule.
 *
 * Testing the helper in isolation (not via defineResource) so
 * regressions surface with a focused signal even if the caller wiring
 * drifts. Complements the integration tests in
 * `tests/core/v2-10-7-schema-inject-regression.test.ts` which cover the
 * full `defineResource → adapter.generateSchemas` flow.
 */

import { describe, expect, it } from "vitest";
import { autoInjectTenantFieldRules } from "../../src/core/schemaOptions.js";

describe("autoInjectTenantFieldRules", () => {
  // ────────────────────────────────────────────────────────────────
  // No-op paths
  // ────────────────────────────────────────────────────────────────

  it("no-ops when tenantField is false (platform-universal resource)", () => {
    const input = { fieldRules: { name: { description: "Display name" } } };
    const result = autoInjectTenantFieldRules(input, false);
    expect(result).toBe(input); // same reference
  });

  it("no-ops when tenantField is undefined (not configured)", () => {
    const input = { fieldRules: { name: { description: "Display name" } } };
    const result = autoInjectTenantFieldRules(input, undefined);
    expect(result).toBe(input);
  });

  it("no-ops when tenantField is set but caller already declared systemManaged: true", () => {
    const input = {
      fieldRules: {
        organizationId: { systemManaged: true, description: "Host override" },
      },
    };
    const result = autoInjectTenantFieldRules(input, "organizationId");
    expect(result).toBe(input);
  });

  it("no-ops when tenantField is set but caller declared systemManaged: false (explicit opt-out)", () => {
    const input = {
      fieldRules: {
        organizationId: { systemManaged: false, description: "Intentional" },
      },
    };
    const result = autoInjectTenantFieldRules(input, "organizationId");
    expect(result).toBe(input);
    // Verifies opt-outs survive — zero chance of arc silently overriding.
    expect(result?.fieldRules?.organizationId?.systemManaged).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────
  // Injection paths
  // ────────────────────────────────────────────────────────────────

  it("injects both flags when schemaOptions is undefined", () => {
    const result = autoInjectTenantFieldRules(undefined, "organizationId");
    expect(result?.fieldRules?.organizationId).toEqual({
      systemManaged: true,
      preserveForElevated: true,
    });
  });

  it("injects both flags when schemaOptions has no fieldRules", () => {
    const input = { hiddenFields: ["__v"] };
    const result = autoInjectTenantFieldRules(input, "organizationId");
    expect(result?.fieldRules?.organizationId).toEqual({
      systemManaged: true,
      preserveForElevated: true,
    });
    // Preserves other unrelated options
    expect(result?.hiddenFields).toEqual(["__v"]);
  });

  it("injects without clobbering sibling rules for other fields", () => {
    const input = {
      fieldRules: {
        name: { description: "Display name", minLength: 2 },
        createdBy: { systemManaged: true },
      },
    };
    const result = autoInjectTenantFieldRules(input, "organizationId");

    expect(result?.fieldRules?.organizationId?.systemManaged).toBe(true);
    expect(result?.fieldRules?.organizationId?.preserveForElevated).toBe(true);
    // Sibling rules are unchanged
    expect(result?.fieldRules?.name).toEqual({ description: "Display name", minLength: 2 });
    expect(result?.fieldRules?.createdBy).toEqual({ systemManaged: true });
  });

  it("uses the configured tenantField name (not hard-coded to organizationId)", () => {
    const result = autoInjectTenantFieldRules(undefined, "accountId");
    expect(result?.fieldRules?.accountId?.systemManaged).toBe(true);
    // Never stamps the literal 'organizationId' key when a different field is configured
    expect(result?.fieldRules?.organizationId).toBeUndefined();
  });

  it("preserves caller-supplied non-systemManaged rule metadata on the tenant field", () => {
    // Caller set some metadata on the tenant field but didn't touch
    // `systemManaged` — helper should merge in the flags without
    // overwriting their description / constraints.
    const input = {
      fieldRules: {
        organizationId: {
          description: "Tenant scope (auto-managed)",
          hidden: true,
        },
      },
    };
    const result = autoInjectTenantFieldRules(input, "organizationId");

    expect(result?.fieldRules?.organizationId).toEqual({
      description: "Tenant scope (auto-managed)",
      hidden: true,
      systemManaged: true,
      preserveForElevated: true,
    });
  });

  it("respects caller-supplied preserveForElevated: false", () => {
    // Host wants systemManaged auto-injected but doesn't want the
    // elevation bypass — should be honored.
    const input = {
      fieldRules: {
        organizationId: { preserveForElevated: false },
      },
    };
    const result = autoInjectTenantFieldRules(input, "organizationId");

    expect(result?.fieldRules?.organizationId?.systemManaged).toBe(true);
    expect(result?.fieldRules?.organizationId?.preserveForElevated).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────
  // Immutability
  // ────────────────────────────────────────────────────────────────

  it("does not mutate the input schemaOptions or its fieldRules", () => {
    const input = {
      fieldRules: {
        name: { description: "keep me" },
      },
    };
    const before = JSON.parse(JSON.stringify(input));
    const result = autoInjectTenantFieldRules(input, "organizationId");

    expect(input).toEqual(before);
    // And the returned object is a new reference
    expect(result).not.toBe(input);
    expect(result?.fieldRules).not.toBe(input.fieldRules);
  });
});
