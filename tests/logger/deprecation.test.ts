import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deprecatedNamespace,
  resetDeprecationWarnings,
  warnDeprecated,
} from "../../src/logger/deprecation.js";
import { permissions, publicRead } from "../../src/permissions/index.js";

describe("deprecation warnings", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const lines = () => warn.mock.calls.map((c) => c.join(" "));

  beforeEach(() => {
    resetDeprecationWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("warns once per key per process, naming the replacement", () => {
    warnDeprecated("`old()`", "Use `next()`.");
    warnDeprecated("`old()`", "Use `next()`.");
    warnDeprecated("`other()`", "Use `again()`.");
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toContain("[arc:deprecated]");
    expect(lines()[0]).toContain("`old()` is deprecated and will be removed in the next minor.");
    expect(lines()[0]).toContain("Use `next()`.");
  });

  it("honours ARC_SUPPRESS_WARNINGS", () => {
    const prev = process.env.ARC_SUPPRESS_WARNINGS;
    process.env.ARC_SUPPRESS_WARNINGS = "1";
    try {
      warnDeprecated("`quiet()`", "Use `loud()`.");
    } finally {
      if (prev === undefined) delete process.env.ARC_SUPPRESS_WARNINGS;
      else process.env.ARC_SUPPRESS_WARNINGS = prev;
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("a deprecated namespace warns on member reads only, not on probes", async () => {
    const ns = deprecatedNamespace({ a: 1 }, "`ns`", "Import `a`.");
    // Awaiting probes `then`; a tag read probes a symbol. Neither is a member.
    await Promise.resolve(ns);
    void Object.prototype.toString.call(ns);
    expect(warn).not.toHaveBeenCalled();
    expect(ns.a).toBe(1);
    expect(lines()).toHaveLength(1);
  });

  it("the `permissions` namespace export still works, and warns once naming the direct import", () => {
    expect(permissions.publicRead).toBe(publicRead);
    expect(typeof permissions.fullPublic()).toBe("object");
    const deprecations = lines().filter((l) => l.includes("The `permissions` namespace export"));
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0]).toContain("import { publicRead } from '@classytic/arc/permissions'");
  });
});
