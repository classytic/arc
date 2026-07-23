/**
 * Module lifecycle — end-to-end SCENARIO.
 *
 * Models how a spine-style ecosystem app composes: an app that owns shared
 * infra (a "db" connection decorated in `plugins()` + closed in `onClose`), and
 * three domain modules — `db` → `catalog` → `order` via `dependsOn` — that each
 * own their own infra (a repeating timer), mount resources, and wire across each
 * other with `getModuleExports`.
 *
 * Asserts, in one realistic flow, the properties the review rounds cared about:
 *   1. Every phase fires in dependency order, module-before-app.
 *   2. A module reads a live dependency export (dependsOn guarantees order).
 *   3. Module-owned infra (a timer) is opened AND cleaned up — no leak.
 *   4. Teardown runs module `onClose` (reverse) BEFORE app `onClose`, so a
 *      module can flush to shared infra that is STILL OPEN (the 2.20 fix).
 *   5. Resources actually mount and serve.
 *
 * Leverages core test helpers (createApp / defineModule / getModuleExports /
 * mock repo) — no bespoke harness.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { defineModule, getModuleExports } from "../../src/factory/module/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

// ── shared infra + engine shapes ─────────────────────────────────────────────

interface SharedDb {
  open: boolean;
  flushed: number;
}
type AppWithDb = FastifyInstance & { sharedDb?: SharedDb };

interface CatalogEngine {
  db: SharedDb;
  timer: ReturnType<typeof setInterval>;
}

// One mock-repo-backed resource per module (unique model prefix so parallel
// suites never collide on mongoose model names).
function moduleResource(routeName: string) {
  const Model = createMockModel(`Eco${routeName[0]?.toUpperCase()}${routeName.slice(1)}`);
  const repo = createMockRepository(Model);
  return defineResource({
    name: routeName,
    adapter: createMongooseAdapter({ model: Model, repository: repo }),
    controller: new BaseController(repo, { resourceName: routeName }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });
}

interface Recorder {
  readonly phases: string[];
  readonly closed: string[];
  /** Whether `catalog.onClose` observed the shared db STILL open. */
  catalogFlushedWhileDbOpen?: boolean;
  /** Whether `order.bootstrap` read a live catalog engine (dependsOn liveness). */
  orderSawLiveCatalog?: boolean;
  /** Set true once catalog's own timer is cleared in onClose. */
  catalogTimerCleared?: boolean;
}

/** Build the ecosystem app; every assertion drives off the shared `rec`. */
async function buildEcosystemApp(rec: Recorder): Promise<FastifyInstance> {
  let catalogTimer: ReturnType<typeof setInterval> | undefined;

  const db = defineModule({
    name: "db",
    plugins: () => void rec.phases.push("db.plugins"),
    bootstrap: () => void rec.phases.push("db.bootstrap"),
    afterResources: () => void rec.phases.push("db.afterResources"),
    onClose: () => void rec.closed.push("db"),
  });

  const catalog = defineModule({
    name: "catalog",
    dependsOn: ["db"],
    plugins: () => void rec.phases.push("catalog.plugins"),
    bootstrap: (f): CatalogEngine => {
      rec.phases.push("catalog.bootstrap");
      const sharedDb = (f as AppWithDb).sharedDb;
      if (!sharedDb) throw new Error("shared db not available at catalog.bootstrap");
      // Module-owned infra — a timer this module must clean up itself.
      catalogTimer = setInterval(() => {}, 1_000_000);
      return { db: sharedDb, timer: catalogTimer };
    },
    resources: () => [moduleResource("ecoproduct")],
    afterResources: () => void rec.phases.push("catalog.afterResources"),
    onClose: (f) => {
      rec.closed.push("catalog");
      // Flush to SHARED infra — must still be open (module onClose runs before
      // app onClose, which closes it). This is the DB/Redis-flush scenario.
      const sharedDb = (f as AppWithDb).sharedDb;
      rec.catalogFlushedWhileDbOpen = sharedDb?.open === true;
      if (sharedDb) sharedDb.flushed++;
      // Clean up module-owned infra.
      if (catalogTimer) {
        clearInterval(catalogTimer);
        rec.catalogTimerCleared = true;
      }
    },
  });

  const order = defineModule({
    name: "order",
    dependsOn: ["catalog"],
    bootstrap: (f) => {
      rec.phases.push("order.bootstrap");
      // Reads catalog's export — guaranteed live by dependsOn.
      const cat = getModuleExports<CatalogEngine>(f, "catalog");
      rec.orderSawLiveCatalog = cat.db.open === true && typeof cat.timer === "object";
    },
    resources: () => [moduleResource("ecoorder")],
    afterResources: () => void rec.phases.push("order.afterResources"),
    onClose: () => void rec.closed.push("order"),
  });

  // Modules listed OUT of dependency order on purpose — dependsOn must fix it.
  return createApp({
    preset: "testing",
    auth: false,
    logger: false,
    modules: [order, catalog, db],
    // App owns shared infra: opened in plugins, closed (last) in onClose.
    plugins: async (f) => {
      (f as AppWithDb).sharedDb = { open: true, flushed: 0 };
      rec.phases.push("app.plugins");
    },
    bootstrap: [() => void rec.phases.push("app.bootstrap")],
    afterResources: () => void rec.phases.push("app.afterResources"),
    onClose: (f) => {
      rec.closed.push("app.onClose");
      const sharedDb = (f as AppWithDb).sharedDb;
      if (sharedDb) sharedDb.open = false; // close shared infra LAST
    },
  });
}

// ── scenario ─────────────────────────────────────────────────────────────────

describe("module lifecycle — ecosystem scenario", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("composes all phases in dependency order, module-before-app", async () => {
    const rec: Recorder = { phases: [], closed: [] };
    const app = await buildEcosystemApp(rec);
    await app.ready();

    expect(rec.phases).toEqual([
      // plugins phase: app first, then modules in dependsOn order
      "app.plugins",
      "db.plugins",
      "catalog.plugins",
      // bootstrap phase: modules (dependsOn order) then app
      "db.bootstrap",
      "catalog.bootstrap",
      "order.bootstrap",
      "app.bootstrap",
      // afterResources phase: modules (dependsOn order) then app
      "db.afterResources",
      "catalog.afterResources",
      "order.afterResources",
      "app.afterResources",
    ]);
    expect(rec.orderSawLiveCatalog).toBe(true); // dependsOn guaranteed liveness
    await app.close();
  });

  it("serves module-mounted resources", async () => {
    const rec: Recorder = { phases: [], closed: [] };
    const app = await buildEcosystemApp(rec);
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/ecoproducts" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ecoorders" })).statusCode).toBe(200);
    await app.close();
  });

  it("tears down modules (reverse) BEFORE app onClose, against still-open shared infra", async () => {
    const rec: Recorder = { phases: [], closed: [] };
    const app = await buildEcosystemApp(rec);
    await app.ready();
    await app.close();

    // reverse composition order (order → catalog → db), THEN the app closes infra
    expect(rec.closed).toEqual(["order", "catalog", "db", "app.onClose"]);
    // the flush inside catalog.onClose hit a LIVE shared db (the 2.20 fix)
    expect(rec.catalogFlushedWhileDbOpen).toBe(true);
  });

  it("cleans up module-owned infra on close — no leaked timer", async () => {
    const rec: Recorder = { phases: [], closed: [] };
    const app = await buildEcosystemApp(rec);
    await app.ready();
    await app.close();

    expect(rec.catalogTimerCleared).toBe(true);
  });
});
