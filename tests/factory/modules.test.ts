/**
 * createApp() `modules` — domain-module composition.
 *
 * A module bundles a domain's bootstrap + resources + afterResources as one
 * value, expanding into the SAME lifecycle phases as a hand-wired app:
 *   modules[].bootstrap → options.bootstrap
 *   modules[].resources → options.resources
 *   modules[].afterResources → options.afterResources
 *
 * These tests pin: routes register, engine-before-resources ordering, phase
 * interleaving with app-level options, multi-module order, fail-fast errors,
 * and backward-compat (no modules).
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import {
  defineModule,
  getModuleExports,
  getOptionalModuleExports,
  hasModuleExports,
  lazyModuleExports,
  lazyRequiredModuleExports,
} from "../../src/factory/module/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

// Own `Mod` model prefix so mongoose model names never collide with the
// `Boot*` models in boot-sequence.test.ts when suites share a process.
function makeResource(name: string) {
  const Model = createMockModel(`Mod${name.charAt(0).toUpperCase()}${name.slice(1)}`);
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

describe("createApp — modules", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("registers a module's resources under the app prefix", async () => {
    const accounting = defineModule({
      name: "accounting",
      resources: [makeResource("account")],
    });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resourcePrefix: "/api/v1",
      modules: [accounting],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/v1/accounts" })).statusCode).toBe(200);
    // Not special-cased — same prefix rules as a top-level resource.
    expect((await app.inject({ method: "GET", url: "/accounts" })).statusCode).toBe(404);

    await app.close();
  });

  it("runs module bootstrap before the module's resources factory (engine live)", async () => {
    let engineReady = false;
    const mod = defineModule({
      name: "domain",
      bootstrap: async () => {
        engineReady = true;
      },
      resources: async () => {
        if (!engineReady) throw new Error("resources factory ran before bootstrap");
        return [makeResource("widget")];
      },
    });

    const app = await createApp({ preset: "testing", auth: false, modules: [mod] });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/widgets" })).statusCode).toBe(200);
    await app.close();
  });

  it("interleaves phases: module.bootstrap → app.bootstrap → module.afterResources → app.afterResources", async () => {
    const order: string[] = [];
    const mod = defineModule({
      name: "m",
      bootstrap: async () => {
        order.push("module.bootstrap");
      },
      resources: [makeResource("thing")],
      afterResources: async () => {
        order.push("module.afterResources");
      },
    });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      modules: [mod],
      bootstrap: [
        async () => {
          order.push("app.bootstrap");
        },
      ],
      afterResources: async () => {
        order.push("app.afterResources");
      },
    });
    await app.ready();

    expect(order).toEqual([
      "module.bootstrap",
      "app.bootstrap",
      "module.afterResources",
      "app.afterResources",
    ]);
    await app.close();
  });

  it("runs module.plugins in the plugins phase: app.plugins → module.plugins → module.bootstrap", async () => {
    const order: string[] = [];
    const mod = defineModule({
      name: "m",
      plugins: async () => {
        order.push("module.plugins");
      },
      bootstrap: async () => {
        order.push("module.bootstrap");
      },
    });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      plugins: async () => {
        order.push("app.plugins");
      },
      modules: [mod],
    });
    await app.ready();

    // Module infra registers after the app's own plugins, before its engines.
    expect(order).toEqual(["app.plugins", "module.plugins", "module.bootstrap"]);
    await app.close();
  });

  it("module.plugins run in dependsOn order (dependency's plugins before dependent's)", async () => {
    const order: string[] = [];
    // `dependent` listed FIRST but dependsOn ['base'] — base's plugins first.
    const dependent = defineModule({
      name: "dependent",
      dependsOn: ["base"],
      plugins: () => void order.push("dependent"),
    });
    const base = defineModule({ name: "base", plugins: () => void order.push("base") });

    const app = await createApp({ preset: "testing", auth: false, modules: [dependent, base] });
    await app.ready();

    expect(order).toEqual(["base", "dependent"]);
    await app.close();
  });

  it("a throwing module.plugins fails boot with the module name", async () => {
    const mod = defineModule({
      name: "broken",
      plugins: () => {
        throw new Error("boom");
      },
    });
    await expect(createApp({ preset: "testing", auth: false, modules: [mod] })).rejects.toThrow(
      /module "broken" plugins\(\) threw: boom/,
    );
  });

  it("composes module resources alongside top-level resources", async () => {
    const sales = defineModule({ name: "sales", resources: [makeResource("order")] });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      modules: [sales],
      resources: [makeResource("health")],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/healths" })).statusCode).toBe(200);
    await app.close();
  });

  it("runs multiple modules' bootstrap in list order", async () => {
    const order: string[] = [];
    const a = defineModule({ name: "a", bootstrap: () => void order.push("a") });
    const b = defineModule({ name: "b", bootstrap: () => void order.push("b") });

    const app = await createApp({ preset: "testing", auth: false, modules: [a, b] });
    await app.ready();

    expect(order).toEqual(["a", "b"]);
    await app.close();
  });

  it("dependsOn orders bootstrap: a dependency boots before its dependent, regardless of list position", async () => {
    const order: string[] = [];
    // reservation listed FIRST but dependsOn ['order'] — order must boot first,
    // and its export must be readable from reservation's bootstrap.
    let seen: unknown;
    const reservation = defineModule({
      name: "reservation",
      dependsOn: ["order"],
      bootstrap: (f) => {
        order.push("reservation");
        seen = getModuleExports(f, "order");
      },
    });
    const orderMod = defineModule({
      name: "order",
      bootstrap: () => {
        order.push("order");
        return { engine: "order-live" };
      },
    });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      modules: [reservation, orderMod],
    });
    await app.ready();

    expect(order).toEqual(["order", "reservation"]);
    expect(seen).toEqual({ engine: "order-live" });
    await app.close();
  });

  it("dependsOn onClose runs in reverse dependency order (dependent closes before its dependency)", async () => {
    const closed: string[] = [];
    const order = defineModule({ name: "order", onClose: () => void closed.push("order") });
    const reservation = defineModule({
      name: "reservation",
      dependsOn: ["order"],
      onClose: () => void closed.push("reservation"),
    });
    // Listed reservation-first; dependency order is [order, reservation], so
    // teardown is the reverse: reservation, then order.
    const app = await createApp({ preset: "testing", auth: false, modules: [reservation, order] });
    await app.ready();
    await app.close();

    expect(closed).toEqual(["reservation", "order"]);
  });

  it("dependsOn on a missing module fails fast at boot", async () => {
    const orphan = defineModule({ name: "reservation", dependsOn: ["order"] });
    await expect(createApp({ preset: "testing", auth: false, modules: [orphan] })).rejects.toThrow(
      /module "reservation" dependsOn "order", which is not composed/,
    );
  });

  it("a dependency cycle fails fast at boot with the path", async () => {
    const a = defineModule({ name: "a", dependsOn: ["b"] });
    const b = defineModule({ name: "b", dependsOn: ["a"] });
    await expect(createApp({ preset: "testing", auth: false, modules: [a, b] })).rejects.toThrow(
      /module dependency cycle: a → b → a/,
    );
  });

  it("module bootstrap failure is fail-fast and names the module", async () => {
    const bad = defineModule({
      name: "billing",
      bootstrap: async () => {
        throw new Error("db down");
      },
    });

    await expect(createApp({ preset: "testing", auth: false, modules: [bad] })).rejects.toThrow(
      /module "billing".*db down/,
    );
  });

  it("accepts a thunk (dynamic form) — resolved once at boot", async () => {
    let evaluated = 0;
    const lazy = () => {
      evaluated++;
      return Promise.resolve(defineModule({ name: "lazy", resources: [makeResource("report")] }));
    };

    const app = await createApp({ preset: "testing", auth: false, modules: [lazy] });
    await app.ready();

    expect(evaluated).toBe(1);
    expect((await app.inject({ method: "GET", url: "/reports" })).statusCode).toBe(200);
    await app.close();
  });

  it("region-pack selection: only the selected thunk is evaluated", async () => {
    let bdEvaluated = 0;
    let usEvaluated = 0;
    const bdPack = () => {
      bdEvaluated++;
      return defineModule({ name: "bd-tax", resources: [makeResource("mushak")] });
    };
    const usPack = () => {
      usEvaluated++;
      return defineModule({ name: "us-tax", resources: [makeResource("form1099")] });
    };

    const region = "BD";
    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      modules: [region === "BD" ? bdPack : usPack],
    });
    await app.ready();

    expect(bdEvaluated).toBe(1);
    expect(usEvaluated).toBe(0); // unselected pack never evaluated
    expect((await app.inject({ method: "GET", url: "/mushaks" })).statusCode).toBe(200);
    await app.close();
  });

  it("accepts a promise form", async () => {
    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      modules: [Promise.resolve(defineModule({ name: "p", resources: [makeResource("invoice")] }))],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/invoices" })).statusCode).toBe(200);
    await app.close();
  });

  it("a thunk resolving to a non-module fails fast with a named error", async () => {
    await expect(
      createApp({
        logger: false,
        preset: "testing",
        auth: false,
        // Namespace-shaped object (the classic dynamic-import mistake).
        modules: [() => ({ createTaxModule: () => ({}) }) as never],
      }),
    ).rejects.toThrow(/not an ArcModule/);
  });

  it("runs module onClose on app.close, in reverse list order", async () => {
    const closed: string[] = [];
    const a = defineModule({ name: "a", onClose: () => void closed.push("a") });
    const b = defineModule({ name: "b", onClose: () => void closed.push("b") });

    const app = await createApp({ preset: "testing", auth: false, modules: [a, b] });
    await app.ready();
    await app.close();

    expect(closed).toEqual(["b", "a"]); // last composed, first closed
  });

  it("teardown order: module onClose (reverse) BEFORE app onClose", async () => {
    // Regression: Fastify runs onClose hooks LIFO, so separate module-teardown
    // and app-onClose hooks fired app-first — the reverse of the documented
    // contract, and unsafe when app onClose closes shared infra (DB/Redis) that
    // module teardown still needs. Now combined into one hook, modules first.
    const closed: string[] = [];
    const a = defineModule({ name: "a", onClose: () => void closed.push("module.a") });
    const b = defineModule({ name: "b", onClose: () => void closed.push("module.b") });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      modules: [a, b],
      onClose: () => void closed.push("app.onClose"), // e.g. app closes DB/Redis here
    });
    await app.ready();
    await app.close();

    // Modules tear down (reverse) FIRST, then the app closes shared infra.
    expect(closed).toEqual(["module.b", "module.a", "app.onClose"]);
  });

  it("records a bootstrap return value at arc.modules[name]; later modules read it typed", async () => {
    let seenByConsumer: { engine: string } | undefined;
    // defineModule infers TExports from the bootstrap return — no cast at
    // the producing end.
    const producer = defineModule({
      name: "producer",
      bootstrap: () => ({ engine: "live" }),
    });
    const consumer = defineModule({
      name: "consumer",
      bootstrap: (f) => {
        // Typed accessor — no cast at the consuming end either.
        seenByConsumer = getModuleExports<{ engine: string }>(f, "producer");
      },
    });

    const app = await createApp({ preset: "testing", auth: false, modules: [producer, consumer] });
    await app.ready();

    expect(seenByConsumer).toEqual({ engine: "live" });
    expect(getModuleExports<{ engine: string }>(app, "producer")).toEqual({ engine: "live" });
    await app.close();
  });

  it("getModuleExports throws a named error for an unknown module", async () => {
    const producer = defineModule({ name: "producer", bootstrap: () => ({ engine: "live" }) });
    const app = await createApp({ preset: "testing", auth: false, modules: [producer] });
    await app.ready();

    expect(() => getModuleExports(app, "ghost")).toThrow(
      /no public export recorded for module "ghost"/,
    );
    expect(() => getModuleExports(app, "ghost")).toThrow(/producer/); // lists what IS available
    await app.close();
  });

  // ── Optional / deferred sibling resolution ─────────────────────────────────
  //
  // These pin the contract hosts were hand-rolling as
  // `(f as unknown as { arc?: { modules?: Record<string, unknown> } }).arc?.modules?.x`
  // — a cast that loses registry typing and, worse, invites capturing the value
  // ONCE at composition time (see the lazy tests below).

  it("getOptionalModuleExports returns undefined for an uncomposed module (no throw)", async () => {
    const producer = defineModule({ name: "producer", bootstrap: () => ({ engine: "live" }) });
    const app = await createApp({ preset: "testing", auth: false, modules: [producer] });
    await app.ready();

    expect(getOptionalModuleExports<{ engine: string }>(app, "producer")).toEqual({
      engine: "live",
    });
    expect(getOptionalModuleExports(app, "ghost")).toBeUndefined();
    // …and no cast was needed to ask, which is the whole point.
    expect(hasModuleExports(app, "producer")).toBe(true);
    expect(hasModuleExports(app, "ghost")).toBe(false);

    await app.close();
  });

  it("getOptionalModuleExports does not walk the prototype chain", async () => {
    const producer = defineModule({ name: "producer", bootstrap: () => ({ engine: "live" }) });
    const app = await createApp({ preset: "testing", auth: false, modules: [producer] });
    await app.ready();

    // A module named like an Object.prototype member must read as ABSENT, not as
    // a function inherited from the prototype (which would be a live-looking
    // "engine" that silently does nothing).
    expect(getOptionalModuleExports(app, "toString")).toBeUndefined();
    expect(getOptionalModuleExports(app, "constructor")).toBeUndefined();
    expect(hasModuleExports(app, "__proto__")).toBe(false);

    await app.close();
  });

  it("getOptionalModuleExports works on an app composed with no modules at all", async () => {
    // `fastify.arc.modules` is never created in this shape — the accessor must
    // answer "absent", not crash on an undefined map.
    const app = await createApp({ preset: "testing", auth: false });
    await app.ready();

    expect(getOptionalModuleExports(app, "anything")).toBeUndefined();
    expect(hasModuleExports(app, "anything")).toBe(false);
    expect(lazyModuleExports(app, "anything")()).toBeUndefined();

    await app.close();
  });

  it("lazyModuleExports resolves at FIRST USE, so compose order cannot matter", async () => {
    // `consumer` is composed BEFORE `producer`, and captures its accessor during
    // its own bootstrap — i.e. before the sibling exists. An eager read here is
    // the silent bug: undefined forever, read as "that module isn't deployed".
    let read: (() => { engine: string } | undefined) | undefined;
    let eagerlyCaptured: unknown = "not-run";

    const consumer = defineModule({
      name: "consumer",
      bootstrap: (f) => {
        eagerlyCaptured = getOptionalModuleExports(f, "producer"); // the WRONG shape
        read = lazyModuleExports<{ engine: string }>(f, "producer"); // the right one
        // Not resolvable yet — the point of the deferral.
        expect(read()).toBeUndefined();
      },
    });
    const producer = defineModule({ name: "producer", bootstrap: () => ({ engine: "live" }) });

    const app = await createApp({
      preset: "testing",
      auth: false,
      modules: [consumer, producer],
    });
    await app.ready();

    // The eager read latched absence; the lazy one now sees the live engine.
    expect(eagerlyCaptured).toBeUndefined();
    expect(read?.()).toEqual({ engine: "live" });

    await app.close();
  });

  it("lazyModuleExports memoizes the resolved value but never memoizes absence", async () => {
    const producer = defineModule({ name: "producer", bootstrap: () => ({ engine: "live" }) });
    const app = await createApp({ preset: "testing", auth: false, modules: [producer] });
    await app.ready();

    const ghost = lazyModuleExports(app, "ghost");
    expect(ghost()).toBeUndefined();
    // Simulate the sibling arriving late (the deferred-registration case).
    const arc = app.arc as { modules?: Record<string, unknown> };
    (arc.modules as Record<string, unknown>).ghost = { engine: "late" };
    expect(ghost()).toEqual({ engine: "late" });

    // Resolved values are cached — the steady-state read is a closure read, not
    // a registry lookup per request.
    const live = lazyModuleExports(app, "producer");
    const first = live();
    (arc.modules as Record<string, unknown>).producer = { engine: "swapped" };
    expect(live()).toBe(first);

    delete (arc.modules as Record<string, unknown>).ghost;
    await app.close();
  });

  it("lazyRequiredModuleExports defers the fail-fast throw to first use", async () => {
    let read: (() => { engine: string }) | undefined;
    const consumer = defineModule({
      name: "consumer",
      bootstrap: (f) => {
        // Constructing the accessor must NOT throw, even though the sibling has
        // not bootstrapped — otherwise a correct composition boot-crashes purely
        // because of list order.
        read = lazyRequiredModuleExports<{ engine: string }>(f, "producer");
      },
    });
    const producer = defineModule({ name: "producer", bootstrap: () => ({ engine: "live" }) });

    const app = await createApp({
      preset: "testing",
      auth: false,
      modules: [consumer, producer],
    });
    await app.ready();
    expect(read?.()).toEqual({ engine: "live" });

    // PRESENCE, unlike the export read, is validated EAGERLY (2.31): a
    // lazily-required module is still a hard dependency, so a name that is not
    // in the composed graph fails where the accessor is created rather than
    // surviving startup and failing on the first request. See
    // tests/factory/module-teardown.test.ts for the boot-time variant.
    expect(() => lazyRequiredModuleExports(app, "ghost")).toThrow(
      /"ghost" is not in the composed module graph/,
    );

    // A composed module that recorded no export still defers to first use,
    // with getModuleExports' message quality.
    const arc = app.arc as { moduleStates?: Record<string, string> };
    (arc.moduleStates as Record<string, string>).exportless = "ready";
    const missing = lazyRequiredModuleExports(app, "exportless");
    expect(() => missing()).toThrow(/no public export recorded for module "exportless"/);
    expect(() => missing()).toThrow(/producer/);

    await app.close();
  });

  it("duplicate module names throw (fail-fast, same strictness as resources)", async () => {
    const a = defineModule({ name: "dupe", bootstrap: () => ({ n: 1 }) });
    const b = defineModule({ name: "dupe", bootstrap: () => ({ n: 2 }) });
    await expect(createApp({ preset: "testing", auth: false, modules: [a, b] })).rejects.toThrow(
      /Duplicate module name "dupe"/,
    );
  });

  it("rejects an empty / whitespace-only module name", async () => {
    for (const name of ["", "   "]) {
      await expect(
        createApp({ preset: "testing", auth: false, modules: [defineModule({ name })] }),
      ).rejects.toThrow(/empty \(or whitespace-only\) `name`/);
    }
  });

  it("no modules — behaves exactly as before (backward compat)", async () => {
    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resources: [makeResource("plain")],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/plains" })).statusCode).toBe(200);
    await app.close();
  });

  // ── owns — module resource supersession ──
  //
  // A module declares `owns: [name]` for the app-level resources it
  // authoritatively provides; arc DROPS the same-named app fork so the module's
  // version registers. Replaces a host-side hand-maintained "which resources did
  // modules take over" filter list with a colocated, per-atom declaration.

  /** An owned resource whose `/ping` route ONLY the module version carries — so
   *  a test can prove the module's copy won (the app fork had no `/ping`). */
  function makeOwnedResourceWithPing(name: string) {
    const Model = createMockModel(`Mod${name.charAt(0).toUpperCase()}${name.slice(1)}`);
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
      routes: [
        {
          method: "GET",
          path: "/ping",
          permissions: allowPublic(),
          rawHandler: async (_req, reply) => reply.send({ from: "module" }),
        },
      ],
    });
  }

  it("a module's `owns` supersedes the app resource of the same name (module version wins)", async () => {
    const widgets = defineModule({
      name: "widgets",
      owns: ["widget"],
      resources: [makeOwnedResourceWithPing("widget")],
    });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resourcePrefix: "/api/v1",
      // A leftover duplicate 'widget' (app + module) would THROW under strict —
      // booting clean proves the app fork was dropped, not merely warned.
      strictResources: true,
      resources: [makeResource("widget"), makeResource("gadget")],
      modules: [widgets],
    });
    await app.ready();

    // The owned resource registers — and it's the MODULE's copy: only it has /ping.
    expect((await app.inject({ method: "GET", url: "/api/v1/widgets" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/widgets/ping" })).statusCode).toBe(200);
    // The non-owned app resource is untouched.
    expect((await app.inject({ method: "GET", url: "/api/v1/gadgets" })).statusCode).toBe(200);

    await app.close();
  });

  it("`owns` a name with no matching APP resource is a silent no-op (module still supplies it)", async () => {
    const solo = defineModule({
      name: "solo",
      // Pre-declared: no app resource of this name exists to supersede. That
      // side is tolerant. The module must still SUPPLY the name — see the
      // unmet-claim tests below.
      owns: ["neverForked"],
      resources: [makeResource("solo"), makeResource("neverForked")],
    });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resourcePrefix: "/api/v1",
      resources: [makeResource("keep")],
      modules: [solo],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/v1/solos" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/keeps" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/neverForkeds" })).statusCode).toBe(200);

    await app.close();
  });

  // An unmet `owns` claim DELETES the app's route and leaves nothing serving
  // it — a silent production 404. `owns` is an explicit authoritative claim, so
  // this is checked unconditionally (not gated behind `strictResources`, which
  // governs the far softer duplicate-discovery case).

  it("fails boot when a module `owns` a name its STATIC resources do not supply", async () => {
    await expect(
      createApp({
        logger: false,
        preset: "testing",
        auth: false,
        modules: [defineModule({ name: "orders", owns: ["order"], resources: [] })],
        resources: [makeResource("order")], // would be silently deleted
      }),
    ).rejects.toThrow(/module "orders" declares owns: \["order"\].*do not supply/s);
  });

  it("fails boot when a module `owns` a name its FACTORY resources do not supply", async () => {
    await expect(
      createApp({
        logger: false,
        preset: "testing",
        auth: false,
        modules: [
          defineModule({
            name: "orders",
            owns: ["order"],
            resources: async () => [makeResource("somethingElse")],
          }),
        ],
        resources: [makeResource("order")],
      }),
    ).rejects.toThrow(/module "orders" declares owns: \["order"\].*do not supply/s);
  });

  it("a SIBLING module supplying the name does not satisfy the claim (ownership is local)", async () => {
    await expect(
      createApp({
        logger: false,
        preset: "testing",
        auth: false,
        modules: [
          defineModule({ name: "claimer", owns: ["order"], resources: [] }),
          // Supplies "order", but did not claim it — the claim stays unmet.
          defineModule({ name: "provider", resources: [makeResource("order")] }),
        ],
      }),
    ).rejects.toThrow(/module "claimer" declares owns: \["order"\]/);
  });

  it("names every unmet claim, and reports what the module DID supply", async () => {
    await expect(
      createApp({
        logger: false,
        preset: "testing",
        auth: false,
        modules: [
          defineModule({
            name: "orders",
            owns: ["order", "quotation", "rfq"],
            resources: [makeResource("order")], // only one of three
          }),
        ],
      }),
    ).rejects.toThrow(/"quotation", "rfq".*Resources supplied by "orders": order/s);
  });

  it("supersession is the UNION across all modules; unowned app resources survive", async () => {
    const modA = defineModule({ name: "modA", owns: ["aaa"], resources: [makeResource("aaa")] });
    const modB = defineModule({ name: "modB", owns: ["bbb"], resources: [makeResource("bbb")] });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resourcePrefix: "/api/v1",
      strictResources: true, // both forks must be dropped, else a dup throws
      resources: [makeResource("aaa"), makeResource("bbb"), makeResource("ccc")],
      modules: [modA, modB],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/v1/aaas" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/bbbs" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/cccs" })).statusCode).toBe(200);

    await app.close();
  });

  it("merges module and app readiness checks in dependency order", async () => {
    const calls: string[] = [];
    const base = defineModule({
      name: "base-health",
      healthChecks: [{ name: "base", check: () => void calls.push("base") || true }],
    });
    const dependent = defineModule({
      name: "dependent-health",
      dependsOn: ["base-health"],
      healthChecks: [{ name: "dependent", check: () => void calls.push("dependent") || true }],
    });

    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      modules: [dependent, base],
      arcPlugins: {
        health: {
          checks: [{ name: "host", check: () => void calls.push("host") || true }],
        },
      },
    });
    const response = await app.inject({ method: "GET", url: "/_health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json().checks.map((check: { name: string }) => check.name)).toEqual([
      "base",
      "dependent",
      "host",
    ]);
    expect(calls).toEqual(["base", "dependent", "host"]);
    await app.close();
  });

  it("fails boot when module and host readiness check names collide", async () => {
    await expect(
      createApp({
        logger: false,
        preset: "testing",
        auth: false,
        modules: [
          defineModule({
            name: "inventory",
            healthChecks: [{ name: "database", check: () => true }],
          }),
        ],
        arcPlugins: {
          health: { checks: [{ name: "database", check: () => true }] },
        },
      }),
    ).rejects.toThrow(/duplicate health-check name "database"/);
  });
});
