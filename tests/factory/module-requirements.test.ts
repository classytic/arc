/**
 * Composition requirements and planning: host ports, presence-only module requirements,
 * platform-first / aggregator-last ordering, the dry-run plan, module closures, and the
 * boots-alone assertion.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ArcModuleInput,
  createApp,
  defineModule,
  extendModule,
  getModuleExports,
  orderModules,
  planModules,
  resolveModuleClosure,
} from "../../src/factory/index.js";
import { assertModuleBootsAlone } from "../../src/testing/assertModuleBootsAlone.js";
import type { TestDatabaseFactory } from "../../src/testing/bootModuleApp.js";

const noDatabase: TestDatabaseFactory<null> = async () => ({
  uri: "none://",
  connection: null,
  teardown: async () => {},
});

async function boot(modules: ArcModuleInput[], ports?: Record<string, unknown>) {
  const app = await createApp({
    preset: "testing",
    auth: false,
    logger: false,
    modules,
    ...(ports ? { ports } : {}),
  });
  await app.ready();
  return app;
}

describe("requires.ports", () => {
  it("reports EVERY composition problem in one error, before any module boots", async () => {
    const booted = vi.fn();
    const modules = [
      defineModule({
        name: "order",
        dependsOn: ["catalog", "pricing"],
        requires: { ports: ["connection", "outbox"], optionalPorts: ["calendar"] },
        bootstrap: booted,
      }),
      defineModule({ name: "catalog", requires: { ports: ["connection"] }, bootstrap: booted }),
      defineModule({ name: "pos", requires: { modules: ["devices"] }, bootstrap: booted }),
    ];
    const err = await boot(modules, { outbox: null, logger: {} }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      [
        "[arc] cannot compose the module graph — nothing was booted (5 problems):",
        '  - module "order" dependsOn "pricing", which is not composed — add the "pricing" module to createApp({ modules }), or drop the dependency',
        '  - module "order" requires port "connection" — supply createApp({ ports: { connection } })',
        // null is not a supplied port
        '  - module "order" requires port "outbox" — supply createApp({ ports: { outbox } })',
        '  - module "catalog" requires port "connection" — supply createApp({ ports: { connection } })',
        '  - module "pos" requires "devices" to be composed — add the "devices" module to createApp({ modules })',
      ].join("\n"),
    );
    expect(booted).not.toHaveBeenCalled();
  });

  it("hands each module ONLY the ports it declared, frozen; an absent optional port is absent", async () => {
    const seen: Record<string, unknown> = {};
    const connection = { db: true };
    const app = await boot(
      [
        defineModule({
          name: "order",
          requires: { ports: ["connection"], optionalPorts: ["calendar"] },
          bootstrap: (_f, { ports }) => {
            seen.order = ports;
          },
        }),
        defineModule({
          name: "loyalty",
          bootstrap: (_f, { ports }) => {
            seen.loyalty = ports;
          },
        }),
      ],
      { connection, logger: {} },
    );
    expect(seen.order).toEqual({ connection });
    expect((seen.order as { connection: unknown }).connection).toBe(connection);
    expect(Object.isFrozen(seen.order)).toBe(true);
    expect(seen.loyalty).toEqual({});
    await app.close();
  });

  it("ignores the requirements of a bridge that is not active", async () => {
    const app = await boot([
      defineModule({ name: "order" }),
      defineModule({
        name: "order-accounting",
        kind: "bridge",
        dependsOn: ["order", "accounting"],
        requires: { ports: ["ledger"] },
      }),
    ]);
    await app.close();
  });
});

describe("requires.modules — presence only", () => {
  it("allows a MUTUAL requirement with no cycle, and adds no ordering edge", async () => {
    const order: string[] = [];
    const app = await boot([
      defineModule({
        name: "invoice",
        requires: { modules: ["accounting"] },
        bootstrap: () => void order.push("invoice"),
      }),
      defineModule({
        name: "accounting",
        requires: { modules: ["invoice"] },
        bootstrap: () => void order.push("accounting"),
      }),
    ]);
    expect(order).toEqual(["invoice", "accounting"]);
    await app.close();
  });
});

describe("ordering by kind", () => {
  it("emits ready platform modules first, keeping list order within each class", () => {
    const names = orderModules([
      defineModule({ name: "order" }),
      defineModule({ name: "auth", kind: "platform" }),
      defineModule({ name: "catalog" }),
      defineModule({ name: "outbox", kind: "platform" }),
    ]).map((m) => m.name);
    expect(names).toEqual(["auth", "outbox", "order", "catalog"]);
  });

  it("never lets platform preference break a declared edge", () => {
    const names = orderModules([
      defineModule({ name: "tenancy" }),
      defineModule({ name: "auth", kind: "platform", dependsOn: ["tenancy"] }),
    ]).map((m) => m.name);
    expect(names).toEqual(["tenancy", "auth"]);
  });

  it("orders an aggregator after every non-aggregator module", () => {
    const names = orderModules([
      defineModule({ name: "cleanup", kind: "aggregator" }),
      defineModule({ name: "order" }),
      defineModule({ name: "auth", kind: "platform" }),
      defineModule({ name: "period-close", kind: "aggregator" }),
      defineModule({ name: "catalog" }),
    ]).map((m) => m.name);
    expect(names).toEqual(["auth", "order", "catalog", "cleanup", "period-close"]);
  });

  it("reports a module that dependsOn an aggregator as a cycle", () => {
    expect(() =>
      orderModules([
        defineModule({ name: "cleanup", kind: "aggregator" }),
        defineModule({ name: "order", dependsOn: ["cleanup"] }),
      ]),
    ).toThrow(/module dependency cycle: (cleanup → order → cleanup|order → cleanup → order)/);
  });
});

describe("planModules", () => {
  it("returns the SAME order createApp boots in, with bridge activation", async () => {
    const booted: string[] = [];
    const mark = (name: string) => () => void booted.push(name);
    const modules = [
      defineModule({ name: "cleanup", kind: "aggregator", bootstrap: mark("cleanup") }),
      defineModule({ name: "order", dependsOn: ["catalog"], bootstrap: mark("order") }),
      defineModule({
        name: "order-catalog",
        kind: "bridge",
        dependsOn: ["order", "catalog"],
        bootstrap: mark("order-catalog"),
      }),
      defineModule({ name: "catalog", bootstrap: mark("catalog") }),
      defineModule({ name: "auth", kind: "platform", bootstrap: mark("auth") }),
      defineModule({ name: "pos-acc", kind: "bridge", dependsOn: ["pos", "order"] }),
    ];
    const plan = await planModules(modules);
    const app = await boot(modules);
    expect(plan.order).toEqual(booted);
    expect(plan.order).toEqual(["auth", "catalog", "order", "order-catalog", "cleanup"]);
    expect(plan.activeBridges).toEqual(["order-catalog"]);
    expect(plan.skippedBridges).toEqual([{ name: "pos-acc", missing: ["pos"] }]);
    await app.close();
  });

  it("never loads a lazy bridge, active or not, and checks its declared ports", async () => {
    const load = vi.fn(async () => defineModule({ name: "x", kind: "bridge", dependsOn: ["a"] }));
    const plan = await planModules([
      defineModule({ name: "a" }),
      { kind: "bridge", name: "x", dependsOn: ["a"], load },
    ]);
    expect(plan.activeBridges).toEqual(["x"]);
    expect(load).not.toHaveBeenCalled();

    await expect(
      planModules([
        defineModule({ name: "a" }),
        {
          kind: "bridge",
          name: "x",
          dependsOn: ["a"],
          requires: { ports: ["ledger"] },
          load,
        },
      ]),
    ).rejects.toThrow('module "x" requires port "ledger"');
  });

  it("fails on missing ports exactly like boot does", async () => {
    const modules = [defineModule({ name: "a", requires: { ports: ["connection"] } })];
    await expect(planModules(modules)).rejects.toThrow('module "a" requires port "connection"');
    await expect(planModules(modules, { ports: { connection: {} } })).resolves.toMatchObject({
      order: ["a"],
    });
  });

  it("refuses a lazy bridge whose loaded requires differ from its declaration", async () => {
    const err = await boot([
      defineModule({ name: "a" }),
      {
        kind: "bridge",
        name: "x",
        dependsOn: ["a"],
        load: () =>
          defineModule({
            name: "x",
            kind: "bridge",
            dependsOn: ["a"],
            requires: { ports: ["ledger"] },
          }),
      },
    ]).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/does not match its declaration/);
  });
});

describe("resolveModuleClosure", () => {
  const all = [
    defineModule({ name: "auth", kind: "platform", dependsOn: ["tenancy"] }),
    defineModule({ name: "tenancy" }),
    defineModule({ name: "catalog" }),
    defineModule({ name: "pricelist" }),
    defineModule({ name: "order", dependsOn: ["catalog"], requires: { modules: ["pricelist"] } }),
    defineModule({ name: "loyalty", dependsOn: ["order"] }),
    defineModule({ name: "order-loyalty", kind: "bridge", dependsOn: ["order", "loyalty"] }),
  ];

  it("is the dependsOn + requires.modules closure plus every platform module, in input order", () => {
    expect(resolveModuleClosure(all, ["order"]).map((m) => m.name)).toEqual([
      "auth",
      "tenancy",
      "catalog",
      "pricelist",
      "order",
    ]);
  });

  it("does not pull bridges in", () => {
    expect(resolveModuleClosure(all, ["loyalty"]).map((m) => m.name)).not.toContain(
      "order-loyalty",
    );
  });

  it("throws on an unknown root or an edge outside the list", () => {
    expect(() => resolveModuleClosure(all, ["nope"])).toThrow(/unknown root module\(s\) "nope"/);
    expect(() =>
      resolveModuleClosure([defineModule({ name: "a", dependsOn: ["b"] })], ["a"]),
    ).toThrow(/module "a" needs "b"/);
  });
});

describe("extendModule — kind and requires", () => {
  it("sets a kind on an unclassified module, and refuses to relabel a declared one", () => {
    expect(extendModule(defineModule({ name: "auth" }), { kind: "platform" }).kind).toBe(
      "platform",
    );
    expect(
      extendModule(defineModule({ name: "auth", kind: "platform" }), { kind: "platform" }).kind,
    ).toBe("platform");
    expect(() =>
      extendModule(defineModule({ name: "b", kind: "bridge", dependsOn: ["a"] }), {
        kind: "platform",
      }),
    ).toThrow(/refusing to relabel it "platform"/);
  });

  it("unions requires; a port required on either side stays required", () => {
    const m = extendModule(
      defineModule({
        name: "a",
        requires: { ports: ["connection"], optionalPorts: ["calendar"], modules: ["x"] },
      }),
      {
        requires: {
          ports: ["calendar"],
          optionalPorts: ["connection", "outbox"],
          modules: ["y", "x"],
        },
      },
    );
    expect(m.requires).toEqual({
      ports: ["connection", "calendar"],
      optionalPorts: ["outbox"],
      modules: ["x", "y"],
    });
  });
});

describe("assertModuleBootsAlone", () => {
  const modules = () => [
    defineModule({ name: "auth", kind: "platform", bootstrap: () => ({ auth: true }) }),
    defineModule({ name: "catalog", bootstrap: () => ({ catalog: true }) }),
    defineModule({
      name: "order",
      dependsOn: ["catalog"],
      bootstrap: (f) => getModuleExports(f, "catalog"),
    }),
    // A hidden edge: reads catalog during bootstrap without declaring it.
    defineModule({ name: "pricing", bootstrap: (f) => getModuleExports(f, "catalog") }),
  ];

  it("boots a module whose edges are declared, and reports the closure", async () => {
    const result = await assertModuleBootsAlone(modules(), "order", { database: noDatabase });
    expect(result.closure).toEqual(["auth", "catalog", "order"]);
  });

  it("fails naming the module whose edge is hidden", async () => {
    await expect(
      assertModuleBootsAlone(modules(), "pricing", { database: noDatabase }),
    ).rejects.toThrow(
      /module "pricing" does not boot alone in its closure \[auth, pricing\]: .*no public export recorded for module "catalog"/s,
    );
  });

  it("fails naming the module when the root is unknown", async () => {
    await expect(
      assertModuleBootsAlone(modules(), "nope", { database: noDatabase }),
    ).rejects.toThrow(/module "nope" does not boot alone/);
  });

  it("passes bridges through (arc activates those whose ends are in the closure) and runs the probe while booted", async () => {
    const booted: string[] = [];
    const list = [
      ...modules(),
      defineModule({
        name: "order-catalog",
        kind: "bridge",
        dependsOn: ["order", "catalog"],
        bootstrap: () => void booted.push("order-catalog"),
      }),
      defineModule({
        name: "pricing-x",
        kind: "bridge",
        dependsOn: ["pricing", "x"],
        bootstrap: () => void booted.push("pricing-x"),
      }),
    ];
    const seen: string[] = [];
    const result = await assertModuleBootsAlone(list, "order", {
      database: noDatabase,
      probe: (t) => void seen.push(Object.keys(t.app.arc?.modules ?? {}).join(",")),
    });
    expect(result.closure).toEqual(["auth", "catalog", "order"]);
    expect(booted).toEqual(["order-catalog"]);
    expect(seen).toEqual(["auth,catalog,order"]);
  });

  it("fails naming the module when the probe throws", async () => {
    await expect(
      assertModuleBootsAlone(modules(), "order", {
        database: noDatabase,
        probe: () => {
          throw new Error('engine slot "inventory" was read before it was filled');
        },
      }),
    ).rejects.toThrow(/module "order" does not boot alone .*engine slot "inventory"/s);
  });

  it("boots several roots together, named together", async () => {
    await expect(
      assertModuleBootsAlone(modules(), ["order", "pricing"], { database: noDatabase }),
    ).resolves.toEqual({ closure: ["auth", "catalog", "order", "pricing"] });
  });
});
