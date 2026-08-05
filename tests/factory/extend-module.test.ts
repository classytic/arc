/**
 * `extendModule` — the merge that a spread cannot be.
 *
 * Two independent hosts on one fleet wrote `{ ...mod, <arm> }`, and both lost
 * package wiring silently. The tests below are named for what was lost, not for
 * the API surface, because the API is trivial and the failure is not: every one
 * of these passes as `undefined` or an empty array if the merge is wrong, and
 * nothing throws either way.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp, defineModule } from "../../src/factory/index.js";
import { extendModule } from "../../src/factory/module/extend.js";
import type { ArcModule } from "../../src/factory/module/types.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

const app = {} as never;
const ctx = {} as never;

/** Resolve an array-or-factory arm the way arc does. */
const resolve = async (arm: unknown): Promise<unknown[]> =>
  (typeof arm === "function" ? await (arm as (f: unknown) => unknown)(app) : arm) as unknown[];

describe("extendModule", () => {
  it("KEEPS the module's event handlers when a host adds its own", async () => {
    /**
     * The order-module failure, exactly. `{ ...mod, eventHandlers: host }`
     * compiled, read as "add", meant "replace", and un-wired revenue attach —
     * so orders placed, payment was never recorded, and nothing threw because
     * refusing an unpaid order is correct.
     */
    const mod = { name: "order", eventHandlers: ["revenue-attach"] } as unknown as ArcModule;
    const out = extendModule(mod, { eventHandlers: ["host-audit"] as never });
    expect(await resolve(out.eventHandlers)).toEqual(["revenue-attach", "host-audit"]);
  });

  it("WRAPS bootstrap instead of letting a host overwrite it", async () => {
    /**
     * The gym failure: `{ ...mod, bootstrap }` replaced the factory's own, so
     * the engine the module was supposed to publish was never created. There is
     * no merge for a single return value, so the type only permits a wrapper —
     * the host must decide, visibly, what happens to `inner`.
     */
    const inner = vi.fn(async () => ({ engine: "real" }));
    const mod = { name: "inventory", bootstrap: inner } as unknown as ArcModule<{ engine: string }>;

    const out = extendModule(mod, {
      bootstrap: (prev) => async (f, c) => {
        const base = await prev?.(f, c);
        return { ...(base as object), extra: true } as never;
      },
    });

    expect(await out.bootstrap?.(app, ctx)).toEqual({ engine: "real", extra: true });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("gives the wrapper `undefined` when the module has no bootstrap", async () => {
    const out = extendModule({ name: "m" } as ArcModule, {
      bootstrap: (prev) => async () => ({ prevWas: prev === undefined }) as never,
    });
    expect(await out.bootstrap?.(app, ctx)).toEqual({ prevWas: true });
  });

  it("resolves factory arms LAZILY, so a deferred engine is not captured early", async () => {
    /**
     * An arm uses the factory form exactly when it needs the booted instance.
     * Resolving either side at merge time would read the engine before
     * bootstrap and capture `undefined` — the precise thing the factory form
     * exists to avoid.
     */
    let booted = false;
    const mod = {
      name: "m",
      scheduledJobs: () => {
        expect(booted).toBe(true);
        return ["module-sweep"];
      },
    } as unknown as ArcModule;

    const out = extendModule(mod, { scheduledJobs: (() => ["host-sweep"]) as never });
    booted = true; // bootstrap happens between composition and arc reading the arm
    expect(await resolve(out.scheduledJobs)).toEqual(["module-sweep", "host-sweep"]);
  });

  it("concatenates healthChecks as a real ARRAY, not a factory", () => {
    /**
     * `healthChecks` and `errorMappers` are declared as plain arrays and arc
     * reads them directly. Handing arc a function here would not throw — the
     * arm would simply contribute nothing while looking populated.
     */
    const mod = { name: "m", healthChecks: ["a"] } as unknown as ArcModule;
    const out = extendModule(mod, { healthChecks: ["b"] as never });
    expect(Array.isArray(out.healthChecks)).toBe(true);
    expect(out.healthChecks).toEqual(["a", "b"]);
  });

  it("unions dependsOn and owns without duplicating", () => {
    const mod = { name: "m", dependsOn: ["outbox"], owns: ["a"] } as unknown as ArcModule;
    const out = extendModule(mod, { dependsOn: ["outbox", "tenancy"], owns: ["b"] });
    expect(out.dependsOn).toEqual(["outbox", "tenancy"]);
    expect(out.owns).toEqual(["a", "b"]);
  });

  it("lets `provided` absorb a list from either side", () => {
    const a = extendModule({ name: "m", owns: "provided" } as ArcModule, { owns: ["x"] });
    const b = extendModule({ name: "m", owns: ["x"] } as ArcModule, { owns: "provided" });
    expect(a.owns).toBe("provided");
    expect(b.owns).toBe("provided");
  });

  it("runs BOTH lifecycle hooks and disposes in reverse", async () => {
    const order: string[] = [];
    const mod = {
      name: "m",
      afterResources: async () => {
        order.push("mod-setup");
        return async () => void order.push("mod-dispose");
      },
    } as unknown as ArcModule;

    const out = extendModule(mod, {
      afterResources: async () => {
        order.push("host-setup");
        return async () => void order.push("host-dispose");
      },
    });

    const disposer = await out.afterResources?.(app, ctx);
    await disposer?.();
    // Module sets up first; teardown mirrors arc's own reverse module order.
    expect(order).toEqual(["mod-setup", "host-setup", "host-dispose", "mod-dispose"]);
  });

  it("passes an arm through untouched when only one side has it", async () => {
    const modOnly = extendModule({ name: "m", eventHandlers: ["x"] } as unknown as ArcModule, {});
    expect(modOnly.eventHandlers).toEqual(["x"]);

    const hostOnly = extendModule({ name: "m" } as ArcModule, { eventHandlers: ["y"] as never });
    expect(await resolve(hostOnly.eventHandlers)).toEqual(["y"]);
  });

  it("never invents arms the module did not declare", () => {
    /**
     * An `undefined` arm must stay absent, not become `[]`. Arc distinguishes
     * "no contribution" from "an empty one" when it decides whether a module
     * participates in an arm at all.
     */
    const out = extendModule({ name: "m" } as ArcModule, {});
    expect("eventHandlers" in out).toBe(false);
    expect("resources" in out).toBe(false);
    expect("bootstrap" in out).toBe(false);
  });

  it("closes the MODULE before the host, so a BYO engine dies last", async () => {
    /**
     * Not LIFO, and not an oversight. In a bring-your-own-engine composition
     * the HOST owns the engine and hands it to the module, so the host's
     * onClose is the one that destroys it. Running that first would tear the
     * engine out from under a module still draining work against it.
     */
    const order: string[] = [];
    const mod = {
      name: "planning",
      onClose: async () => void order.push("module-drain"),
    } as unknown as ArcModule;
    const out = extendModule(mod, { onClose: async () => void order.push("host-destroy-engine") });
    await out.onClose?.(app);
    expect(order).toEqual(["module-drain", "host-destroy-engine"]);
  });

  it("keeps the module's identity", () => {
    expect(extendModule({ name: "order" } as ArcModule, { dependsOn: ["x"] }).name).toBe("order");
  });
});

/**
 * Shape is not consumption.
 *
 * Every case above inspects the object `extendModule` returns. That proves the
 * merge is correct and proves nothing about whether ARC accepts the result —
 * and the merge deliberately changes an arm's runtime type, handing back a
 * FACTORY where the module had a plain array. Arc resolves both forms, but
 * "resolves both forms" is a property of arc that a shape assertion cannot
 * check and that a future arc could quietly lose.
 *
 * So this boots a real app whose module has been extended on three arms at once
 * and asserts each one actually registered.
 */
describe("extendModule — arc consumes the merged shape", () => {
  it("registers the module's AND the host's eventHandlers + scheduledJobs after a merge", async () => {
    const seen: string[] = [];
    const handler = (tag: string) => async () => void seen.push(tag);

    const base = defineModule({
      name: "orders",
      eventHandlers: [
        { name: "orders.revenue-attach", event: "order:created", handler: handler("module") },
      ],
      scheduledJobs: [{ name: "orders.reconcile", every: 60_000, handler: async () => {} }],
    });

    // The host adds to both arms. Before extendModule this was a spread, and
    // the module's own contribution on each arm was dropped.
    const extended = extendModule(base, {
      eventHandlers: [
        { name: "host.audit", event: "order:created", handler: handler("host") },
      ] as never,
      scheduledJobs: (() => [
        { name: "host.sweep", every: 60_000, handler: async () => {} },
      ]) as never,
    });

    const app = await createApp({ auth: false, logger: false, modules: [extended] });
    await app.ready();

    await app.events.publish("order:created", { id: "o1" });
    // BOTH ran: the module's subscriber survived the host adding its own.
    expect(seen).toEqual(["module", "host"]);

    // And the array arm merged with a FACTORY arm still reached the scheduler.
    expect(app.arc.scheduledJobs?.map((j) => j.name)).toEqual(["orders.reconcile", "host.sweep"]);

    await app.close();
  });
});

describe("extendModule — a merged `resources` arm still mounts", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("mounts the module's resource AND the host's after the merge", async () => {
    /**
     * The arm where the failure is quietest. A dropped resource throws nothing;
     * its routes are simply absent, and the first symptom is a 404 reported days
     * later. Merging also turns a plain array into a factory here, so this is
     * the case that proves arc resolves the factory form for `resources` too.
     */
    const makeResource = (name: string) => {
      const Model = createMockModel(`Ext${name.charAt(0).toUpperCase()}${name.slice(1)}`);
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
    };

    const base = defineModule({ name: "billing", resources: [makeResource("invoice")] });
    const extended = extendModule(base, { resources: [makeResource("credit")] as never });

    const app = await createApp({
      auth: false,
      logger: false,
      preset: "testing",
      resourcePrefix: "/api/v1",
      modules: [extended],
    });
    await app.ready();

    // The package's resource survived the host adding one beside it.
    expect((await app.inject({ method: "GET", url: "/api/v1/invoices" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/credits" })).statusCode).toBe(200);

    await app.close();
  });
});
