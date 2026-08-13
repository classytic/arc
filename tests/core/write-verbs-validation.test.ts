/**
 * A declared write verb that can never RUN is decoration — and decoration is
 * the failure mode this whole seam exists to remove.
 *
 * Every case below reads, at the call site, as though the kernel's guarded
 * command owns the slot. In each one arc would serve generic CRUD instead, and
 * the author would find out from the damage rather than from the wiring. So
 * they are registration-time ERRORS, not warnings.
 */

import { describe, expect, it } from "vitest";
import { validateResourceConfig } from "../../src/core/validateResourceConfig.js";
import type { ResourceConfig } from "../../src/types/index.js";

const adapter = { repository: {} } as unknown as ResourceConfig["adapter"];

function config(overrides: Partial<ResourceConfig>): ResourceConfig {
  return { name: "invoice", adapter, ...overrides } as ResourceConfig;
}

const errorFields = (c: ResourceConfig): string[] =>
  validateResourceConfig(c, { skipControllerCheck: true }).errors.map((e) => e.field);

describe("`writes` validation", () => {
  it("accepts verbs whose slots are mounted", () => {
    const result = validateResourceConfig(
      config({ writes: { create: async () => ({}) as never, update: async () => ({}) as never } }),
      { skipControllerCheck: true },
    );
    expect(result.errors.filter((e) => e.field === "writes")).toHaveLength(0);
  });

  it("REFUSES a verb whose CRUD slot is disabled", () => {
    const errs = validateResourceConfig(
      config({ disabledRoutes: ["update"], writes: { update: async () => ({}) as never } }),
      { skipControllerCheck: true },
    ).errors.filter((e) => e.field === "writes");

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toMatch(/update/);
    expect(errs[0]?.message).toMatch(/can never run/);
  });

  it("names only the unmounted verbs, not the mounted ones", () => {
    const errs = validateResourceConfig(
      config({
        disabledRoutes: ["delete"],
        writes: { create: async () => ({}) as never, delete: async () => undefined },
      }),
      { skipControllerCheck: true },
    ).errors.filter((e) => e.field === "writes");

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toContain("delete");
    expect(errs[0]?.message).not.toContain("create");
  });

  it("REFUSES verbs on a resource with no default CRUD at all", () => {
    expect(
      errorFields(
        config({ disableDefaultRoutes: true, writes: { create: async () => ({}) as never } }),
      ),
    ).toContain("writes");
  });

  /**
   * Without a repository arc builds no controller, so the slots — and the
   * verbs — never mount. The GENERIC adapter check already rejects this
   * config; a second `writes`-branded error for the same root cause was
   * removed as redundant (proven by a control: the config fails identically
   * without `writes`). This test pins the dedup decision: still rejected,
   * exactly once, under the field that names the actual cause.
   */
  it("REFUSES verbs with no adapter repository — via the one generic adapter error", () => {
    const c = { name: "invoice", writes: { create: async () => ({}) as never } } as ResourceConfig;
    const result = validateResourceConfig(c, { skipControllerCheck: true });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("adapter");
    // No duplicate `writes` error piling onto the same root cause.
    expect(result.errors.filter((e) => e.field === "writes")).toHaveLength(0);
  });

  /**
   * Arc is a JAVASCRIPT runtime framework — TypeScript types do not protect a
   * JS host, and a malformed entry degrading into generic CRUD is a security
   * regression, not a style issue. Both malformed shapes are ERRORS.
   */
  it("REFUSES a non-function verb entry (string, the classic JS mistake)", () => {
    const errs = validateResourceConfig(config({ writes: { update: "updateDraft" } as never }), {
      skipControllerCheck: true,
    }).errors.filter((e) => e.field === "writes.update");

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toMatch(/a string/);
    expect(errs[0]?.message).toMatch(/not a function/);
  });

  it("REFUSES an undefined verb entry — declared-but-missing is an authoring bug", () => {
    const errs = validateResourceConfig(config({ writes: { update: undefined } as never }), {
      skipControllerCheck: true,
    }).errors.filter((e) => e.field === "writes.update");

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toMatch(/undefined/);
  });

  it("REFUSES unknown slot names — a typo'd slot is silently never called", () => {
    const errs = validateResourceConfig(config({ writes: { patch: async () => ({}) } as never }), {
      skipControllerCheck: true,
    }).errors.filter((e) => e.field === "writes");

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toContain("patch");
    expect(errs[0]?.message).toMatch(/create, update, delete/);
  });

  it("warns on an empty `writes` block rather than silently ignoring it", () => {
    const result = validateResourceConfig(config({ writes: {} }), { skipControllerCheck: true });
    expect(result.warnings.map((w) => w.field)).toContain("writes");
  });

  it("says nothing when no verbs are declared", () => {
    const result = validateResourceConfig(config({}), { skipControllerCheck: true });
    expect(result.errors.filter((e) => e.field === "writes")).toHaveLength(0);
    expect(result.warnings.filter((w) => w.field === "writes")).toHaveLength(0);
  });
});
