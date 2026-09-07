/**
 * `preset: 'production'` reports the fail-loud switches that are OFF.
 *
 * It REPORTS rather than SETS on purpose, and that is the property under test:
 * all three flags are read where the object is constructed (`defineResource` at
 * define time, `QueryParser` / `BodySanitizer` in their constructors), and a
 * host imports its resources before it calls `createApp`. Setting
 * `process.env` here would be wired-to-read and do nothing — the exact silent
 * failure this warning exists to surface.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

const FLAGS = [
  "ARC_STRICT_PERMISSIONS",
  "ARC_STRICT_QUERY_PARAMS",
  "ARC_STRICT_IMMUTABLE_WRITES",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  for (const f of FLAGS) delete process.env[f];
});

afterEach(() => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});

async function bootAndCollect(preset: "production" | "testing"): Promise<string[]> {
  const lines: string[] = [];
  const app = await createApp({
    preset,
    auth: false,
    helmet: false,
    cors: false,
    rateLimit: false,
    underPressure: false,
    logger: { level: "warn", stream: { write: (s: string) => void lines.push(s) } } as never,
  });
  await app.close();
  return lines;
}

/** The one warning this file is about, if it was emitted. */
function strictWarning(lines: string[]): string | undefined {
  return lines.find((l) => l.includes("fail-loud OFF"));
}

describe("preset: 'production' — fail-loud reporting", () => {
  it("names every flag that is off", async () => {
    const warning = strictWarning(await bootAndCollect("production"));
    expect(warning).toBeDefined();
    for (const flag of FLAGS) expect(warning).toContain(flag);
  });

  it("says what each one COSTS while off, not just its name", async () => {
    const warning = strictWarning(await bootAndCollect("production"));
    // A list of env var names tells an operator nothing about the risk.
    expect(warning).toContain("WIDENS the read");
    expect(warning).toContain("warns instead of failing boot");
    expect(warning).toContain("returns 200, unchanged");
  });

  it("says the flags must be set BEFORE resource imports", async () => {
    // Without this, an operator sets them next to createApp and they no-op.
    const warning = strictWarning(await bootAndCollect("production"));
    expect(warning).toMatch(/BEFORE any resource import/);
  });

  it("names ONLY the flags that are off", async () => {
    process.env.ARC_STRICT_QUERY_PARAMS = "true";
    const warning = strictWarning(await bootAndCollect("production"));
    expect(warning).toBeDefined();
    expect(warning).toContain("ARC_STRICT_PERMISSIONS");
    expect(warning).not.toContain("ARC_STRICT_QUERY_PARAMS");
  });

  it("stays SILENT when all three are on", async () => {
    for (const f of FLAGS) process.env[f] = "true";
    expect(strictWarning(await bootAndCollect("production"))).toBeUndefined();
  });

  it("does not fire outside the production preset", async () => {
    // A dev/test app is deliberately permissive; warning there is noise that
    // trains people to ignore the warning that matters.
    expect(strictWarning(await bootAndCollect("testing"))).toBeUndefined();
  });

  it("treats any value other than the exact string 'true' as off", async () => {
    for (const f of FLAGS) process.env[f] = "1";
    const warning = strictWarning(await bootAndCollect("production"));
    expect(warning).toBeDefined();
    for (const flag of FLAGS) expect(warning).toContain(flag);
  });
});

describe("skipValidation does not disable the permission invariant", () => {
  /**
   * `skipValidation` is documented as "skip schema validation" and is set
   * IMPLICITLY by `customRoutesOnly`. It used to gate the ungated-write check
   * too, so a flag a host reaches for on structural grounds silently switched
   * off a security invariant — even under `ARC_STRICT_PERMISSIONS`.
   */
  const crudResource = (extra: Record<string, unknown>) => ({
    name: "widget",
    prefix: "/widgets",
    adapter: {
      repository: {
        find: async () => [],
        findById: async () => null,
        create: async () => ({}),
        update: async () => ({}),
        delete: async () => ({}),
        count: async () => 0,
      },
    },
    ...extra,
  });

  it("still refuses an ungated WRITE under strict mode when skipValidation is on", async () => {
    process.env.ARC_STRICT_PERMISSIONS = "true";
    const { defineResource } = await import("../../src/core/defineResource.js");
    expect(() => defineResource(crudResource({ skipValidation: true }) as never)).toThrow(
      /no permission gate/i,
    );
  });

  it("is inert for customRoutesOnly — no CRUD mounts, so nothing to gate", async () => {
    process.env.ARC_STRICT_PERMISSIONS = "true";
    const { defineResource } = await import("../../src/core/defineResource.js");
    expect(() =>
      defineResource({
        name: "service",
        prefix: "/service",
        customRoutesOnly: true,
        routes: [],
      } as never),
    ).not.toThrow();
  });
});
