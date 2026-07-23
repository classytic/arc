/**
 * bootModuleApp (2.22) — the module-composability harness, upstreamed
 * from the spine testkit. Pins: context factory receives a LIVE
 * connection + mongoUri, modules (incl. async thunks inside arrays)
 * boot into a real app, exports land at arc.modules.<name>, and
 * close() tears everything down.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineModule } from "../../src/factory/module/index.js";
import type { ModuleTestApp, TestkitContext } from "../../src/testing/bootModuleApp.js";
import { bootModuleApp } from "../../src/testing/bootModuleApp.js";

let t: ModuleTestApp;
let seenCtx: TestkitContext | undefined;

describe("bootModuleApp", () => {
  beforeAll(async () => {
    t = await bootModuleApp((ctx) => {
      seenCtx = ctx;
      return [
        // Async thunk inside the array — resolved during module-graph resolution.
        async () =>
          defineModule({
            name: "demo",
            bootstrap: () => ({ engineReady: true, uri: ctx.mongoUri }),
          }),
      ];
    });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it("hands the factory a live in-memory DB context", () => {
    expect(seenCtx?.mongoUri).toMatch(/^mongodb:\/\//);
    expect(seenCtx?.connection).toBeTruthy();
  });

  it("boots a real arc app with the module's export registered", () => {
    const demo = t.exports<{ engineReady: boolean; uri: string }>("demo");
    expect(demo.engineReady).toBe(true);
    expect(demo.uri).toBe(t.mongoUri);
  });

  it("exports() throws helpfully for unknown module names", () => {
    expect(() => t.exports("nope")).toThrow(/nope/);
  });

  it("boots READY — serving immediately, routes frozen (matches real apps)", async () => {
    // App is already listening post-boot: a request is served (404 through
    // the real HTTP stack), and late route additions are correctly rejected.
    const res = await t.app.inject({ method: "GET", url: "/nowhere" });
    expect(res.statusCode).toBe(404);
    expect(() => t.app.get("/late", async () => ({}))).toThrow(/already listening/);
  });

  it("DB seam: a custom `database` factory replaces Mongo entirely", async () => {
    let toreDown = false;
    const fakeConn = { kind: "fake-driver" };
    const t2 = await bootModuleApp<typeof fakeConn>(
      (ctx) => [
        defineModule({
          name: "agnostic",
          bootstrap: () => ({ sawConn: ctx.connection.kind, uri: ctx.uri }),
        }),
      ],
      {
        database: async () => ({
          uri: "fake://db",
          connection: fakeConn,
          teardown: async () => {
            toreDown = true;
          },
        }),
      },
    );
    // No mongod, no mongoose — the harness never named a driver.
    expect(t2.exports<{ sawConn: string; uri: string }>("agnostic")).toEqual({
      sawConn: "fake-driver",
      uri: "fake://db",
    });
    await t2.close();
    expect(toreDown).toBe(true);
  });
});
