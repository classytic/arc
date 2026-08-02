/**
 * `owns: "provided"` + resolved module descriptors (2.32).
 *
 * Ownership derivation, duplicate rejection, and supersession are ONE
 * arc-managed phase: resources resolve exactly once, names are validated, the
 * effective `owns` is derived, and only then are host forks dropped.
 *
 * The explicit-array form stays supported and still fails a claim the module
 * does not satisfy — but it is no longer the only option, and the derived form
 * makes the drift class unrepresentable rather than merely detected. Two real
 * production bugs motivated it, both silent 404s and neither a type error: a
 * POS module claiming a checkout resource it mounted only when the host
 * supplied a pipeline, and a device gateway claiming a name it never provided.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { defineModule } from "../../src/factory/module/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

function makeResource(name: string) {
  const Model = createMockModel(`Own${name.charAt(0).toUpperCase()}${name.slice(1)}`);
  const repo = createMockRepository(Model);
  return defineResource({
    name,
    adapter: createMongooseAdapter({ model: Model, repository: repo }),
    controller: new BaseController(repo, { resourceName: name }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });
}

const boot = (options: Parameters<typeof createApp>[0]) =>
  createApp({ logger: false, preset: "testing", auth: false, ...options });

describe('owns: "provided"', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("derives the claim from the resources the module actually mounted", async () => {
    const mod = defineModule({
      name: "sales",
      owns: "provided",
      resources: () => [makeResource("invoice"), makeResource("quote")],
    });

    const app = await boot({ modules: [mod] });
    await app.ready();

    const descriptor = app.arc?.moduleDescriptors?.find((d) => d.name === "sales");
    expect(descriptor?.owns).toEqual(["invoice", "quote"]);
    await app.close();
  });

  it("tracks a CONDITIONAL resource — the exact drift that shipped two bugs", async () => {
    const build = (withCheckout: boolean) =>
      defineModule({
        name: "pos",
        owns: "provided",
        resources: () => [
          makeResource("posShift"),
          ...(withCheckout ? [makeResource("posOrder")] : []),
        ],
      });

    for (const [withCheckout, expected] of [
      [true, ["posShift", "posOrder"]],
      [false, ["posShift"]],
    ] as const) {
      const app = await boot({ modules: [build(withCheckout)] });
      await app.ready();
      expect(app.arc?.moduleDescriptors?.[0]?.owns).toEqual(expected);
      await app.close();
    }
  });

  it("supersedes the host fork for every derived name", async () => {
    const mod = defineModule({
      name: "sales",
      owns: "provided",
      resources: () => [makeResource("order")],
    });

    // strictResources would THROW on a surviving duplicate, so booting clean
    // proves the app fork was dropped rather than merely warned about.
    const app = await boot({
      modules: [mod],
      strictResources: true,
      resources: [makeResource("order"), makeResource("gadget")],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/gadgets" })).statusCode).toBe(200);
    await app.close();
  });

  it("fails boot when the module supplies no named resources to derive from", async () => {
    // Almost always a resources factory that returned early; an empty claim
    // would silently supersede nothing.
    await expect(
      boot({ modules: [defineModule({ name: "empty", owns: "provided", resources: () => [] })] }),
    ).rejects.toThrow(/declares `owns: "provided"` but supplies no named resources/);
  });

  it("rejects duplicate resource names WITHIN one module, unconditionally", async () => {
    // Not gated behind `strictResources`: a host may legitimately hold a fork
    // mid-migration, but a module contradicting ITSELF has no such excuse.
    await expect(
      boot({
        modules: [
          defineModule({
            name: "dup",
            owns: "provided",
            resources: () => [makeResource("thing"), makeResource("thing")],
          }),
        ],
      }),
    ).rejects.toThrow(/provides two resources named "thing"/);
  });

  it("still enforces the explicit-array form", async () => {
    await expect(
      boot({
        modules: [
          defineModule({
            name: "orders",
            owns: ["order", "ghost"],
            resources: () => [makeResource("order")],
          }),
        ],
      }),
    ).rejects.toThrow(/declares owns: \["ghost"\].*do not supply/s);
  });
});

describe("resolved module descriptors", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("reports the resolved graph without the caller re-deriving it", async () => {
    const base = defineModule({ name: "base", resources: () => [makeResource("thing")] });
    const dependent = defineModule({
      name: "dependent",
      dependsOn: ["base"],
      owns: "provided",
      bootstrap: () => ({ engine: true }),
      onClose: () => {},
      healthChecks: [{ name: "hc", check: () => true }],
      resources: () => [makeResource("widget")],
    });

    const app = await boot({ modules: [dependent, base] });
    await app.ready();

    const descriptors = app.arc?.moduleDescriptors ?? [];
    // Descriptors follow COMPOSITION order, not list order.
    expect(descriptors.map((d) => d.name)).toEqual(["base", "dependent"]);

    const d = descriptors.find((x) => x.name === "dependent");
    expect(d?.dependsOn).toEqual(["base"]);
    expect(d?.resources.map((r) => r.name)).toEqual(["widget"]);
    expect(d?.owns).toEqual(["widget"]);
    expect(d?.lifecycle).toMatchObject({ hasClose: true, healthChecks: 1, exports: true });
    await app.close();
  });

  it("reports REAL subscription + schedule counts, not zeros", async () => {
    // Descriptors were originally published before the contribution arms
    // resolved, so every module reported 0 subscriptions and 0 schedules even
    // when it had them — and being frozen, they were never corrected. Tooling
    // could not distinguish "none" from "not counted yet". They now publish
    // after §6, fed by the counts the collectors recorded during their single
    // resolution pass.
    const mod = defineModule({
      name: "busy",
      resources: () => [makeResource("thing")],
      eventHandlers: [
        { name: "busy.a", event: "x:created", handler: async () => {} },
        { name: "busy.b", event: "y:created", handler: async () => {} },
      ],
      scheduledJobs: [{ name: "busy.sweep", every: 3_600_000, handler: () => {} }],
      healthChecks: [{ name: "busy.ready", check: () => true }],
    });

    const app = await boot({ modules: [mod] });
    await app.ready();

    const d = app.arc?.moduleDescriptors?.find((x) => x.name === "busy");
    expect(d?.lifecycle).toMatchObject({
      subscriptions: 2,
      scheduledJobs: 1,
      healthChecks: 1,
    });
    await app.close();
  });

  it("counts a FACTORY contribution without resolving it twice", async () => {
    // A contribution factory closes over booted engines and may allocate, so
    // resolving it again purely to introspect would run host code twice.
    let resolutions = 0;
    const mod = defineModule({
      name: "lazy",
      bootstrap: () => ({ ready: true }),
      resources: () => [makeResource("late")],
      eventHandlers: () => {
        resolutions++;
        return [{ name: "lazy.h", event: "z:created", handler: async () => {} }];
      },
    });

    const app = await boot({ modules: [mod] });
    await app.ready();

    expect(resolutions).toBe(1);
    expect(app.arc?.moduleDescriptors?.[0]?.lifecycle.subscriptions).toBe(1);
    await app.close();
  });

  it("is frozen plain data — cloneable, and cannot be mutated out of sync", async () => {
    const app = await boot({
      modules: [defineModule({ name: "m", resources: () => [makeResource("row")] })],
    });
    await app.ready();

    const d = app.arc?.moduleDescriptors?.[0];
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d?.resources)).toBe(true);
    // No live handles: safe across a worker boundary or into a file.
    expect(() => structuredClone(d)).not.toThrow();
    await app.close();
  });
});
