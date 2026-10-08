/**
 * The mounted definitions, read back after boot — `registry.getDefinitions()` and
 * `getModuleResources(fastify, module)` — so a host builds MCP tools / docs from what actually
 * mounted instead of re-collecting each module's list by hand.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp, defineModule, getModuleResources } from "../../src/factory/index.js";
import type { McpPluginOptions } from "../../src/integrations/mcp/types.js";
import { allowPublic } from "../../src/permissions/index.js";

const serviceResource = (name: string, skipRegistry = false) =>
  defineResource({
    name,
    customRoutesOnly: true,
    skipRegistry,
    routes: [
      { method: "GET", path: "/ping", permissions: allowPublic(), handler: async () => ({ name }) },
    ],
  });

describe("mounted resource definitions", () => {
  it("returns every mounted definition, and each module's own", async () => {
    const invoice = serviceResource("invoice");
    const credit = serviceResource("credit");
    const stock = serviceResource("stock");
    const internal = serviceResource("internal", true);
    const health = serviceResource("health");

    const app = await createApp({
      auth: false,
      logger: false,
      preset: "testing",
      modules: [
        defineModule({ name: "billing", resources: [invoice, credit] }),
        defineModule({ name: "inventory", resources: () => [stock, internal] }),
        defineModule({ name: "empty" }),
      ],
      resources: [health],
    });
    try {
      await app.ready();
      const registry = app.arc?.registry;
      if (!registry) throw new Error("arc registry missing");

      // The SAME objects that mounted — identity, not a rebuilt copy. `skipRegistry` opted out.
      const all = registry.getDefinitions();
      expect(new Set(all)).toEqual(new Set([invoice, credit, stock, health]));
      expect(registry.getDefinition("invoice")).toBe(invoice);
      expect(registry.getDefinition("internal")).toBeUndefined();

      // Per composed module, in declared order — including a factory-resolved arm.
      expect(getModuleResources(app, "billing")).toEqual([invoice, credit]);
      expect(getModuleResources(app, "inventory")).toEqual([stock]);
      expect(getModuleResources(app, "empty")).toEqual([]);

      // A typo must not read as "this module has no resources".
      expect(() => getModuleResources(app, "biling")).toThrow(
        /"biling" is not a composed module\. Composed: billing, inventory, empty/,
      );

      // A fresh array per call: mutating it cannot change the registry.
      all.length = 0;
      expect(registry.getDefinitions()).toHaveLength(4);

      // The result feeds mcpPlugin directly — no cast at the host.
      const mcp: Pick<McpPluginOptions, "resources"> = {
        resources: getModuleResources(app, "billing"),
      };
      expect(mcp.resources).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("refuses before a module graph exists, and forgets definitions on close", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      preset: "testing",
      resources: [serviceResource("health")],
    });
    await app.ready();
    const registry = app.arc?.registry;
    expect(registry?.getDefinitions()).toHaveLength(1);
    expect(() => getModuleResources(app, "billing")).toThrow(/not a composed module/);
    const bare = Fastify({ logger: false });
    expect(() => getModuleResources(bare, "billing")).toThrow(/no composed module graph/);
    await bare.close();
    await app.close(); // arcCorePlugin resets the registry on close
    expect(registry?.getDefinitions()).toEqual([]);
  });
});
