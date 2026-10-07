/**
 * The fail-loud switches default ON. Unset, each refuses what it guards; an explicit `false` opts
 * out, and `preset: 'production'` names every opt-out and what it costs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BodySanitizer } from "../../src/core/BodySanitizer.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

const FLAGS = [
  "ARC_STRICT_PERMISSIONS",
  "ARC_STRICT_QUERY_PARAMS",
  "ARC_STRICT_IMMUTABLE_WRITES",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  // The suite opts out globally (tests/_helpers/load-env.ts); these tests need the real default.
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
    runtime: "memory",
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

function strictWarning(lines: string[]): string | undefined {
  return lines.find((l) => l.includes("fail-loud turned OFF"));
}

const crud = {
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
};

describe("the fail-loud defaults, with nothing set", () => {
  it("an ungated write refuses to boot", () => {
    expect(() => defineResource(crud as never)).toThrow(/no permission gate/i);
  });

  it("an unknown filter key is refused, not dropped", () => {
    const parser = new ArcQueryParser({ allowedFilterFields: ["status"] });
    expect(() => parser.parse({ priority: "high" })).toThrow(/priority/);
  });

  it("an immutable-field write is rejected, not stripped", () => {
    const sanitizer = new BodySanitizer({
      schemaOptions: { fieldRules: { sku: { immutable: true } } },
    } as never);
    expect((sanitizer as unknown as { onImmutableWrite: string }).onImmutableWrite).toBe("reject");
  });
});

describe("preset: 'production' — opt-out reporting", () => {
  it("stays SILENT with nothing set — strict is the default", async () => {
    expect(strictWarning(await bootAndCollect("production"))).toBeUndefined();
  });

  it("names each flag turned off, and what it costs", async () => {
    process.env.ARC_STRICT_QUERY_PARAMS = "false";
    const warning = strictWarning(await bootAndCollect("production"));
    expect(warning).toContain("ARC_STRICT_QUERY_PARAMS");
    expect(warning).toContain("WIDENS the read");
    expect(warning).not.toContain("ARC_STRICT_PERMISSIONS");
  });

  it("reads 1 / yes as on — the spelling does not decide enforcement", async () => {
    process.env.ARC_STRICT_PERMISSIONS = "1";
    process.env.ARC_STRICT_QUERY_PARAMS = "yes";
    expect(strictWarning(await bootAndCollect("production"))).toBeUndefined();
  });

  it("a value it cannot read fails boot, naming the variable", async () => {
    process.env.ARC_STRICT_PERMISSIONS = "ture";
    await expect(bootAndCollect("production")).rejects.toThrow(/ARC_STRICT_PERMISSIONS/);
  });

  it("does not fire outside the production preset", async () => {
    process.env.ARC_STRICT_QUERY_PARAMS = "false";
    expect(strictWarning(await bootAndCollect("testing"))).toBeUndefined();
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

describe("preset: 'production' requires a declared topology", () => {
  it("refuses to boot without `runtime` — the instance count is declared, never guessed", async () => {
    await expect(
      createApp({ preset: "production", auth: false, logger: false } as never),
    ).rejects.toThrow(/requires an explicit `runtime`.*'memory' for a single instance/s);
  });

  it("boots with an explicit single-instance runtime", async () => {
    const app = await createApp({
      preset: "production",
      runtime: "memory",
      auth: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      logger: false,
    });
    await app.close();
  });
});
