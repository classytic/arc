/**
 * Module-contributed health checks — `defineModule({ healthChecks })`.
 *
 * Pins the contract: a domain module carries its OWN readiness checks, and
 * composing the module is sufficient for them to appear on `/_health/ready`
 * — the host's composition root no longer collects them by hand. Collection
 * is dependency-ordered, modules-first then the host's app-level checks, and
 * duplicate names fail loudly at boot (attributing both owners). The same
 * union reaches the worker probe via `fastify.arc.healthChecks`.
 */

import { describe, expect, it } from "vitest";
import { createApp, createWorker, defineModule } from "../../src/factory/index.js";

const ok = () => true;

describe("defineModule — healthChecks", () => {
  it("collects module checks (dep order) then app checks, and serves them on /_health/ready", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      // 'b' listed first but dependsOn 'a' → orderModules puts 'a' first.
      modules: [
        defineModule({
          name: "b",
          dependsOn: ["a"],
          healthChecks: [{ name: "b-check", check: ok }],
        }),
        defineModule({ name: "a", healthChecks: [{ name: "a-check", check: ok }] }),
      ],
      arcPlugins: { health: { checks: [{ name: "host-check", check: ok }] } },
    });
    await app.ready();

    // Frozen, dependency-ordered module contribution on the decorator.
    expect(app.arc.healthChecks?.map((c) => c.name)).toEqual(["a-check", "b-check"]);
    expect(Object.isFrozen(app.arc.healthChecks)).toBe(true);

    // End-to-end: all three run, modules-first then host.
    const res = await app.inject({ method: "GET", url: "/_health/ready" });
    const names = res.json().checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(["a-check", "b-check", "host-check"]);

    await app.close();
  });

  it("fails at boot on a duplicate check name across modules, naming both owners", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({ name: "inventory", healthChecks: [{ name: "engine", check: ok }] }),
          defineModule({ name: "catalog", healthChecks: [{ name: "engine", check: ok }] }),
        ],
      }),
    ).rejects.toThrow(/duplicate health-check name "engine".*"inventory".*"catalog"/s);
  });

  it("fails at boot when an app-level check collides with a module check", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [defineModule({ name: "inventory", healthChecks: [{ name: "flow", check: ok }] })],
        arcPlugins: { health: { checks: [{ name: "flow", check: ok }] } },
      }),
    ).rejects.toThrow(/duplicate health-check name "flow".*arcPlugins\.health/s);
  });

  it("a module with NO healthChecks is unchanged (boots, empty contribution)", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [defineModule({ name: "plain", resources: [] })],
    });
    await app.ready();
    expect(app.arc.healthChecks).toEqual([]);
    await app.close();
  });

  it("the worker probe receives the module check union (single registration)", async () => {
    const worker = await createWorker({
      logger: false,
      modules: [defineModule({ name: "jobs", healthChecks: [{ name: "queue", check: ok }] })],
    });
    // Module checks reached the worker's arc (what the probe registration reads).
    expect(worker.app.arc.healthChecks?.map((c) => c.name)).toEqual(["queue"]);
    await worker.close();
  });
});
