/**
 * Module-contributed workflows — `defineModule({ workflows })`.
 *
 * Arc core treats workflow values as OPAQUE (never imports streamline): it only
 * collects them in dependency order via `collectModuleWorkflows`, resolving
 * factory contributions so they can close over a container the integration
 * decorated on the instance. The streamline integration owns name/shape
 * validation + registration. `fastify.arc.moduleDefinitions` is exposed so the
 * integration can drive collection at its own init time.
 */

import { describe, expect, it } from "vitest";
import { collectModuleWorkflows, createApp, defineModule } from "../../src/factory/index.js";

describe("defineModule — workflows (opaque, integration-collected)", () => {
  it("collects static + factory workflow contributions in dependency order", async () => {
    // 'b' dependsOn 'a' → 'a' resolves first.
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({ name: "b", dependsOn: ["a"], workflows: [{ id: "wf-b" }] }),
        defineModule({ name: "a", workflows: (f) => [{ id: "wf-a", sawFastify: Boolean(f) }] }),
      ],
    });
    await app.ready();
    const wfs = await collectModuleWorkflows(app, app.arc.moduleDefinitions ?? []);
    expect(wfs).toEqual([{ id: "wf-a", sawFastify: true }, { id: "wf-b" }]);
    await app.close();
  });

  it("exposes dependency-ordered, frozen moduleDefinitions on fastify.arc", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [defineModule({ name: "x" }), defineModule({ name: "y" })],
    });
    await app.ready();
    expect(app.arc.moduleDefinitions?.map((m) => m.name)).toEqual(["x", "y"]);
    expect(Object.isFrozen(app.arc.moduleDefinitions)).toBe(true);
    await app.close();
  });

  it("a module with no workflows contributes nothing", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [defineModule({ name: "plain" })],
    });
    await app.ready();
    expect(await collectModuleWorkflows(app, app.arc.moduleDefinitions ?? [])).toEqual([]);
    await app.close();
  });
});
