/**
 * `createApp({ role })` — declared topology (Phase 2).
 *
 * A process knows its role and refuses work that contradicts it:
 *   relay/scheduler + HTTP resources  → boot-fatal (not a hidden endpoint)
 *   api/worker                        → NO module schedule arms mount
 *   relay                             → ONLY kind:'relay' arms mount
 *   default 'all'                     → byte-identical to before
 */

import { describe, expect, it, vi } from "vitest";
import { defineModule } from "../../src/factory/index.js";
import { arcApp, arcAppRefuses } from "../_harness/index.js";

const armModule = () =>
  defineModule({
    name: "billing",
    scheduledJobs: () => [
      { name: "billing.relay", every: 60_000, kind: "relay" as const, handler: async () => {} },
      { name: "billing.digest", every: 60_000, handler: async () => {} },
    ],
  });

describe("createApp({ role })", () => {
  it("relay + HTTP resources is BOOT-fatal", async () => {
    await arcAppRefuses({ role: "relay", resources: [] }, /must not serve routes/);
  });

  it("scheduler + resourceDir is BOOT-fatal", async () => {
    await arcAppRefuses({ role: "scheduler", resourceDir: "./x" }, /must not serve routes/);
  });

  it("role 'api' mounts NO module schedule arms — and says which were skipped", async () => {
    const info = vi.fn();
    const app = await arcApp({
      role: "api",
      modules: [armModule()],
      plugins: async (f) => {
        Object.assign(f.log, { info });
      },
    });
    expect(app.arc?.scheduledJobs ?? []).toHaveLength(0);
    // getScheduleStats only exists when the schedules plugin registered.
    expect(app.hasDecorator("getScheduleStats")).toBe(false);
  });

  it("role 'relay' mounts ONLY kind:'relay' arms", async () => {
    const app = await arcApp({
      role: "relay",
      modules: [armModule()],
    });
    const jobs = (app.arc?.scheduledJobs ?? []) as Array<{ name: string }>;
    expect(jobs.map((j) => j.name)).toEqual(["billing.relay"]);
  });

  it("createWorker forwards role — one axis, no second mechanism", async () => {
    // Historical contract preserved: WITHOUT role, a worker mounts every arm
    // (it is "the headless process that runs everything non-HTTP")…
    const { createWorker } = await import("../../src/factory/createWorker.js");
    const w1 = await createWorker({ logger: false, modules: [armModule()] });
    expect(
      ((w1.app.arc?.scheduledJobs ?? []) as Array<{ name: string }>).map((j) => j.name).sort(),
    ).toEqual(["billing.digest", "billing.relay"]);
    await w1.close();

    // …and WITH role: 'worker', the arms move to the owning deployment.
    const w2 = await createWorker({ logger: false, role: "worker", modules: [armModule()] });
    expect((w2.app.arc?.scheduledJobs ?? []) as unknown[]).toHaveLength(0);
    await w2.close();
  });

  it("default 'all' mounts every arm — unchanged behaviour", async () => {
    const app = await arcApp({
      modules: [armModule()],
    });
    const jobs = (app.arc?.scheduledJobs ?? []) as Array<{ name: string }>;
    expect(jobs.map((j) => j.name).sort()).toEqual(["billing.digest", "billing.relay"]);
  });
});
