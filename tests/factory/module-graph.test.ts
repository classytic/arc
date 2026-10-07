/**
 * The module graph: bridges activate only when every domain they join is composed, each event
 * has one owner inside its module's namespace, and every consumed event has a publisher —
 * checked at boot, and rendered as a map people and agents read instead of grepping.
 */
import { describe, expect, it } from "vitest";
import {
  activateBridges,
  analyzeModuleGraph,
  buildModuleGraph,
  createApp,
  crudEventsOf,
  defineModule,
  dependentsOf,
  eventTopology,
  extendModule,
  renderModuleGraph,
  verifyModuleGraph,
} from "../../src/factory/index.js";
import { resolveModules } from "../../src/factory/module/resolve.js";

const noop = async () => {};

describe("activateBridges", () => {
  it("drops a bridge whose domain is missing — and a bridge built on that bridge — keeps domains", () => {
    const { active, skipped } = activateBridges([
      defineModule({ name: "order" }),
      defineModule({
        name: "order-accounting",
        kind: "bridge",
        dependsOn: ["order", "accounting"],
      }),
      defineModule({
        name: "order-accounting-bd",
        kind: "bridge",
        dependsOn: ["order-accounting"],
      }),
    ]);
    expect(active.map((m) => m.name)).toEqual(["order"]);
    expect(skipped).toEqual([
      { name: "order-accounting", missing: ["accounting"] },
      { name: "order-accounting-bd", missing: ["order-accounting"] },
    ]);
  });

  it("activates a bridge when every domain it joins is composed", () => {
    const { active, skipped } = activateBridges([
      defineModule({ name: "order" }),
      defineModule({ name: "accounting" }),
      defineModule({
        name: "order-accounting",
        kind: "bridge",
        dependsOn: ["order", "accounting"],
      }),
    ]);
    expect(active).toHaveLength(3);
    expect(skipped).toEqual([]);
  });
});

describe("LazyBridge — decided before it is imported", () => {
  it("an inactive lazy bridge is never loaded; an active one is, in input order", async () => {
    const loads: string[] = [];
    const lazy = (name: string, dependsOn: string[]) => ({
      kind: "bridge" as const,
      name,
      dependsOn,
      load: async () => {
        loads.push(name);
        return defineModule({ name, kind: "bridge", dependsOn });
      },
    });
    const { active, skipped } = await resolveModules([
      defineModule({ name: "order" }),
      lazy("order-accounting", ["order", "accounting"]),
      lazy("order-audit", ["order"]),
      () => defineModule({ name: "audit-tail" }),
    ]);
    expect(loads).toEqual(["order-audit"]);
    expect(active.map((m) => m.name)).toEqual(["order", "order-audit", "audit-tail"]);
    expect(skipped).toEqual([{ name: "order-accounting", missing: ["accounting"] }]);
  });

  it("refuses a loaded module that does not match its declaration", async () => {
    await expect(
      resolveModules([
        defineModule({ name: "order" }),
        {
          kind: "bridge",
          name: "order-audit",
          dependsOn: ["order"],
          load: () => defineModule({ name: "order-audit", kind: "bridge", dependsOn: ["billing"] }),
        },
      ]),
    ).rejects.toThrow(/does not match its declaration/);
  });

  it("boots through createApp without importing the dropped bridge", async () => {
    let loaded = false;
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({ name: "order" }),
        {
          kind: "bridge",
          name: "order-accounting",
          dependsOn: ["order", "accounting"],
          load: () => {
            loaded = true;
            return defineModule({ name: "order-accounting", kind: "bridge" });
          },
        },
      ],
    });
    await app.ready();
    expect(loaded).toBe(false);
    expect(app.arc.moduleGraph?.skippedBridges).toEqual([
      { name: "order-accounting", missing: ["accounting"] },
    ]);
    await app.close();
  });
});

describe("verifyModuleGraph", () => {
  const graph = (
    modules: Parameters<typeof defineModule>[0][],
    consumes: Record<string, string[]>,
    external: string[] = [],
  ) =>
    buildModuleGraph(
      modules.map((m) => defineModule(m)),
      new Map(Object.entries(consumes)),
      [],
      external,
    );

  it("a sound graph has no issues — wildcard consumers and external sources count", () => {
    const issues = verifyModuleGraph(
      graph(
        [{ name: "order", publishes: ["order:placed", "order:cancelled"] }, { name: "notify" }],
        { notify: ["order:*", "auth:signed-up"] },
        ["auth:*"],
      ),
    );
    expect(issues).toEqual([]);
  });

  it("an event has ONE owner", () => {
    const issues = verifyModuleGraph(
      graph(
        [
          { name: "order", publishes: ["order:placed"] },
          { name: "pos", eventNamespace: "order", publishes: ["order:placed"] },
        ],
        {},
      ),
    );
    expect(issues.map((i) => i.code)).toEqual(["duplicate-owner"]);
  });

  it("a module publishes only inside its own namespace — joining domains is a bridge's job", () => {
    const issues = verifyModuleGraph(
      graph([{ name: "order", publishes: ["accounting:cod.cancelled"] }], {}),
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: "outside-namespace", module: "order" }),
    ]);
  });

  it("a consumed event with no active publisher is reported", () => {
    const issues = verifyModuleGraph(
      graph([{ name: "accounting" }], { accounting: ["order:placed"] }),
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: "no-publisher", event: "order:placed" }),
    ]);
  });
});

describe("createApp — the module graph at boot", () => {
  it("an inactive bridge never subscribes — switching a domain off needs no gate code", async () => {
    const seen: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({ name: "order", publishes: ["order:placed"] }),
        defineModule({
          name: "order-accounting",
          kind: "bridge",
          dependsOn: ["order", "accounting"],
          eventHandlers: [
            {
              name: "order-accounting.post-sale",
              event: "order:placed",
              handler: async () => void seen.push("posted"),
            },
          ],
        }),
      ],
    });
    await app.ready();
    await app.events.publish("order:placed", { id: "o1" });
    expect(seen).toEqual([]);
    expect(app.arc.moduleGraph?.skippedBridges).toEqual([
      { name: "order-accounting", missing: ["accounting"] },
    ]);
    await app.close();
  });

  it("strict mode REFUSES to boot a consumer with no publisher", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        moduleGraph: { events: "strict" },
        modules: [
          defineModule({
            name: "accounting",
            eventHandlers: [{ event: "order:placed", handler: noop }],
          }),
        ],
      }).then((app) => app.ready()),
    ).rejects.toThrow(/consumes "order:placed", which no active module publishes/);
  });

  it("preset: 'production' reports ownership gaps by default — boots, but says so", async () => {
    const graphLines = async (preset: "production" | undefined) => {
      const lines: string[] = [];
      const app = await createApp({
        ...(preset ? { preset, runtime: "memory" as const } : {}),
        auth: { type: "jwt", jwt: { secret: "a-test-secret-that-is-at-least-32-characters" } },
        logger: { level: "warn", stream: { write: (s: string) => void lines.push(s) } } as never,
        modules: [
          defineModule({
            name: "accounting",
            eventHandlers: [{ event: "order:placed", handler: noop }],
          }),
        ],
      });
      await app.ready();
      await app.close();
      return lines.filter((l) => l.includes("order:placed"));
    };
    expect(await graphLines("production")).not.toEqual([]);
    expect(await graphLines(undefined)).toEqual([]);
  });

  it("publishes the resolved graph and renders it as a map", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      moduleGraph: { events: "strict" },
      modules: [
        defineModule({ name: "order", publishes: ["order:placed"] }),
        defineModule({ name: "accounting" }),
        defineModule({
          name: "order-accounting",
          kind: "bridge",
          dependsOn: ["order", "accounting"],
          eventHandlers: [{ event: "order:placed", handler: noop }],
        }),
      ],
    });
    await app.ready();
    const graph = app.arc.moduleGraph;
    expect(graph?.modules.find((m) => m.name === "order-accounting")).toMatchObject({
      kind: "bridge",
      consumes: ["order:placed"],
    });
    if (!graph) throw new Error("the resolved graph is missing");
    const map = renderModuleGraph(graph);
    expect(map).toContain("| order:placed | order | `order-accounting` |");
    await app.close();
  });
});

describe("ownership prefixes and the coupling matrix", () => {
  const graph = (
    modules: Parameters<typeof defineModule>[0][],
    consumes: Record<string, string[]>,
  ) =>
    buildModuleGraph(
      modules.map((m) => defineModule(m)),
      new Map(Object.entries(consumes)),
      [],
    );

  it("a kernel's dotted events and a module owning two aggregates are inside their namespaces", () => {
    const g = graph(
      [
        { name: "revenue", eventNamespace: "payment", publishes: ["payment.succeeded"] },
        {
          name: "order",
          eventNamespace: ["order", "rma"],
          publishes: ["order:placed", "rma:settled"],
        },
      ],
      {},
    );
    expect(verifyModuleGraph(g)).toEqual([]);
  });

  it("a prefix is a whole segment — 'order' does not own 'orders:x'", () => {
    const g = graph([{ name: "order", publishes: ["orders:placed"] }], {});
    expect(verifyModuleGraph(g).map((i) => i.code)).toEqual(["outside-namespace"]);
  });

  it("dependentsOf answers 'what breaks if I switch this off' — starved consumers and dropped bridges", () => {
    const g = graph(
      [
        { name: "order", publishes: ["order:placed", "order:shipped"] },
        { name: "accounting" },
        { name: "notify" },
        { name: "order-accounting", kind: "bridge", dependsOn: ["order", "accounting"] },
      ],
      { accounting: ["order:*"], notify: ["order:placed"] },
    );
    const analysis = analyzeModuleGraph(g);
    expect(analysis.coupling.get("accounting")?.get("order")).toEqual([
      "order:placed",
      "order:shipped",
    ]);
    expect(dependentsOf(g, "order", analysis)).toEqual({
      starved: [
        { module: "accounting", events: ["order:placed", "order:shipped"] },
        { module: "notify", events: ["order:placed"] },
      ],
      droppedBridges: ["order-accounting"],
    });
    expect(renderModuleGraph(g, analysis)).toContain(
      "| accounting | order | `order:placed`, `order:shipped` |",
    );
  });
});

describe("derived CRUD publishes — from what MOUNTED, never overstated", () => {
  it("only mounted mutations publish; no adapter or default routes off publishes nothing", () => {
    expect(crudEventsOf({ name: "widget", adapter: {} })).toEqual([
      "widget.created",
      "widget.updated",
      "widget.deleted",
    ]);
    expect(crudEventsOf({ name: "widget", adapter: {}, disabledRoutes: ["delete"] })).toEqual([
      "widget.created",
      "widget.updated",
    ]);
    expect(crudEventsOf({ name: "widget" })).toEqual([]);
    expect(crudEventsOf({ name: "widget", adapter: {}, disableDefaultRoutes: true })).toEqual([]);
  });

  it("a module owns its resources' events — a consumer of a disabled mutation is starved, loudly", () => {
    const g = buildModuleGraph(
      [defineModule({ name: "catalog" }), defineModule({ name: "search" })],
      new Map([["search", ["product.created", "product.deleted"]]]),
      [],
      [],
      new Map([
        [
          "catalog",
          {
            publishes: crudEventsOf({ name: "product", adapter: {}, disabledRoutes: ["delete"] }),
            namespaces: ["product"],
          },
        ],
      ]),
    );
    const issues = verifyModuleGraph(g);
    expect(issues.map((i) => [i.code, i.event])).toEqual([["no-publisher", "product.deleted"]]);
  });
});

describe("eventTopology — divide by coupling", () => {
  it("finds an event cycle and layers the rest in dependency order", () => {
    const g = buildModuleGraph(
      [
        defineModule({ name: "catalog", publishes: ["catalog:product.created"] }),
        defineModule({ name: "order", publishes: ["order:placed"] }),
        defineModule({ name: "loyalty", publishes: ["loyalty:points.earned"] }),
        defineModule({ name: "accounting" }),
      ],
      new Map([
        ["order", ["catalog:*", "loyalty:*"]],
        ["loyalty", ["order:placed"]],
        ["accounting", ["order:placed"]],
      ]),
      [],
    );
    const { cycles, layers } = eventTopology(g);
    expect(cycles).toEqual([["loyalty", "order"]]);
    expect(layers).toEqual([["catalog"], ["loyalty", "order"], ["accounting"]]);
  });
});

describe("extendModule — a host adds the facts IT emits", () => {
  it("unions namespaces (keeping the module's implicit one) and concatenates publishes", () => {
    const mod = extendModule(defineModule({ name: "auth", publishes: ["auth:session.revoked"] }), {
      publishes: ["user:signed-up"],
      eventNamespace: "user",
    });
    expect(mod.eventNamespace).toEqual(["auth", "user"]);
    expect(mod.publishes).toEqual(["auth:session.revoked", "user:signed-up"]);
    expect(verifyModuleGraph(buildModuleGraph([mod], new Map(), []))).toEqual([]);
  });
});
