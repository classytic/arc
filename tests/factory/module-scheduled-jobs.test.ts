/**
 * Module-contributed schedules compose into Arc's canonical schedules plugin.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineModule, getModuleExports } from "../../src/factory/index.js";
import schedulesPlugin from "../../src/plugins/schedules.js";

const noop = async () => {};

afterEach(() => {
  vi.useRealTimers();
});

describe("defineModule — scheduledJobs", () => {
  it("executes schedules and exposes frozen definitions in dependency order", async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "b",
          dependsOn: ["a"],
          scheduledJobs: [
            {
              name: "b.sweep",
              every: 1_000,
              runOnStart: true,
              handler: () => void runs.push("b"),
            },
          ],
        }),
        defineModule({
          name: "a",
          scheduledJobs: [
            {
              name: "a.sweep",
              every: 1_000,
              runOnStart: true,
              handler: () => void runs.push("a"),
            },
          ],
        }),
      ],
    });
    await app.ready();
    await vi.advanceTimersByTimeAsync(0);

    expect(runs).toEqual(["a", "b"]);
    expect(app.arc.scheduledJobs?.map((job) => job.name)).toEqual(["a.sweep", "b.sweep"]);
    expect(Object.isFrozen(app.arc.scheduledJobs)).toBe(true);
    expect(Object.isFrozen(app.arc.scheduledJobs?.[0])).toBe(true);
    expect(app.arc.plugins.has("arc-schedules")).toBe(true);
    await app.close();
  });

  it("resolves a factory once after bootstraps", async () => {
    let resolutions = 0;
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "orders",
          bootstrap: () => ({ tag: "orders" }),
          scheduledJobs: (fastify) => {
            resolutions++;
            // Read the sibling export through the PUBLIC accessor — this is
            // the pattern module authors should copy, and it proves the
            // factory runs after bootstraps (getModuleExports throws if not).
            const { tag } = getModuleExports<{ tag: string }>(fastify, "orders");
            return [{ name: `${tag}.sweep`, every: 1_000, handler: noop }];
          },
        }),
      ],
    });
    await app.ready();

    expect(resolutions).toBe(1);
    expect(app.arc.scheduledJobs?.map((job) => job.name)).toEqual(["orders.sweep"]);
    await app.close();
  });

  it("fails boot when module schedules are explicitly disabled", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        arcPlugins: { schedules: false },
        modules: [
          defineModule({
            name: "cleanup",
            scheduledJobs: [{ name: "cleanup.sweep", every: 1_000, handler: noop }],
          }),
        ],
      }),
    ).rejects.toThrow(/scheduledJobs.*arcPlugins\.schedules is false/);
  });

  it("rejects manual scheduler registration instead of creating two runners", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        plugins: async (fastify) => {
          await fastify.register(schedulesPlugin, { schedules: [] });
        },
        modules: [
          defineModule({
            name: "cleanup",
            scheduledJobs: [{ name: "cleanup.sweep", every: 1_000, handler: noop }],
          }),
        ],
      }),
    ).rejects.toThrow(/schedulesPlugin was already registered manually.*arcPlugins\.schedules/);
  });

  it("fails boot on duplicate names with both module owners", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "a",
            scheduledJobs: [{ name: "sweep", every: 1_000, handler: noop }],
          }),
          defineModule({
            name: "b",
            scheduledJobs: [{ name: "sweep", every: 1_000, handler: noop }],
          }),
        ],
      }),
    ).rejects.toThrow(/duplicate scheduled-job name "sweep".*"a".*"b"/s);
  });

  it.each([
    [{ name: "bad", every: 0, handler: noop }, /every.*positive number/],
    [{ name: "bad", every: Number.NaN, handler: noop }, /every.*positive number/],
    [{ name: "bad", every: 1_000, jitterMs: -1, handler: noop }, /jitterMs.*non-negative/],
    [{ name: "bad", every: 1_000, leaseMs: 0, handler: noop }, /leaseMs.*positive/],
  ])("rejects an invalid canonical schedule: %o", async (schedule, message) => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [defineModule({ name: "bad", scheduledJobs: [schedule] })],
      }),
    ).rejects.toThrow(message);
  });
});
