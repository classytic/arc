/**
 * Better Auth adapter THUNK (2.22) — the lazy seam for adapters whose
 * construction needs a live DB (BA's `mongodbAdapter(mongoose.connection
 * .getClient().db())` throws before the connection opens).
 *
 * Pins the load-bearing contract: the thunk resolves AFTER `beforeBoot`
 * (so `beforeBoot: connectDatabase` + a thunked adapter is a valid
 * ordering), sync and async thunks both work, and the eager object form
 * keeps working unchanged (back-compat).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/factory/createApp.js";

const apps: Array<{ close(): Promise<void> }> = [];

function fakeAdapter(onRegister: () => void) {
  return {
    plugin: async (fastify: FastifyInstance) => {
      onRegister();
      fastify.decorate("authenticate", async () => undefined);
    },
  };
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("auth.betterAuth thunk (2.22)", () => {
  it("resolves the thunk AFTER beforeBoot — the connect-then-auth ordering", async () => {
    const order: string[] = [];
    const app = await createApp({
      logger: false,
      preset: "testing",
      beforeBoot: async () => {
        order.push("beforeBoot");
      },
      auth: {
        type: "betterAuth",
        // Async thunk — the shape BA-on-Mongo hosts need
        // (`() => createBetterAuthAdapter({ auth: getAuth() })`).
        betterAuth: async () => {
          order.push("thunk-resolved");
          return fakeAdapter(() => order.push("plugin-registered"));
        },
      },
    });
    apps.push(app);
    expect(order).toEqual(["beforeBoot", "thunk-resolved", "plugin-registered"]);
  });

  it("sync thunks work too", async () => {
    let resolved = false;
    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: {
        type: "betterAuth",
        betterAuth: () => {
          resolved = true;
          return fakeAdapter(() => undefined);
        },
      },
    });
    apps.push(app);
    expect(resolved).toBe(true);
  });

  it("the eager object form keeps working unchanged (back-compat)", async () => {
    let registered = false;
    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: {
        type: "betterAuth",
        betterAuth: fakeAdapter(() => {
          registered = true;
        }),
      },
    });
    apps.push(app);
    expect(registered).toBe(true);
  });
});
