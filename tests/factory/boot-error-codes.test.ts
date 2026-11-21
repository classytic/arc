/**
 * Every configuration boot failure from createApp and its audits is an ArcBootError carrying
 * a stable code and a one-line fix per problem. Message wording is pinned by the owning tests;
 * this file pins the codes.
 */
import { describe, expect, it } from "vitest";
import { ArcBootError, createApp, defineModule } from "../../src/factory/index.js";
import type { CreateAppOptions } from "../../src/factory/types/index.js";
import { declareRuntimeCapability } from "../../src/utils/runtimeCapabilities.js";

async function refusal(options: CreateAppOptions): Promise<ArcBootError> {
  const err = await createApp({ logger: false, auth: false, ...options }).then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ArcBootError);
  const boot = err as ArcBootError;
  for (const p of boot.problems) expect(p.fix.length).toBeGreaterThan(0);
  return boot;
}

describe("boot failures carry codes", () => {
  it("production without a declared runtime", async () => {
    const err = await refusal({ preset: "production" });
    expect(err.code).toBe("production-runtime-undeclared");
  });

  it("a relay role that declares resources", async () => {
    const err = await refusal({ role: "relay", resources: [] });
    expect(err.code).toBe("role-declares-resources");
  });

  it("a JWT auth config without a secret", async () => {
    const err = await refusal({ auth: { type: "jwt", jwt: {} } } as CreateAppOptions);
    expect(err.code).toBe("auth-jwt-secret-missing");
  });

  it("distributed runtime with memory stores lists one problem per missing store", async () => {
    const err = await refusal({ runtime: "distributed", underPressure: false });
    expect(err.problems.map((p) => p.code)).toContain("distributed-requires-shared-store");
    expect(err.problems.map((p) => p.message)).toContain(
      "runtime: 'distributed' needs stores.events",
    );
  });

  it("the end-of-boot runtime capability audit", async () => {
    const shared = { name: "redis", publish: async () => {}, subscribe: async () => () => {} };
    const err = await refusal({
      runtime: "distributed",
      underPressure: false,
      rateLimit: false,
      stores: { events: shared as never, idempotency: { name: "redis" } as never },
      plugins: async (f) => {
        declareRuntimeCapability(f, { subsystem: "webhooks.subscriptions", durability: "memory" });
      },
    });
    expect(err.problems).toEqual([expect.objectContaining({ code: "runtime-memory-state" })]);
    expect(err.problems[0]?.message).toContain("webhooks.subscriptions");
  });

  it("composition problems keep their codes and gain a fix line", async () => {
    const err = await refusal({
      modules: [defineModule({ name: "order", requires: { ports: ["outbox" as never] } })],
    });
    expect(err.problems).toEqual([
      {
        code: "missing-port",
        module: "order",
        message: 'module "order" requires port "outbox" — supply createApp({ ports: { outbox } })',
        fix: "supply createApp({ ports: { outbox } })",
      },
    ]);
  });

  it("a duplicate health-check name", async () => {
    const ok = () => true;
    const err = await refusal({
      modules: [defineModule({ name: "a", healthChecks: [{ name: "db", check: ok }] })],
      arcPlugins: { health: { checks: [{ name: "db", check: ok }] } },
    });
    expect(err.code).toBe("duplicate-health-check");
  });
});
