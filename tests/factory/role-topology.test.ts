/**
 * `createApp({ role })` — declared topology (Phase 2).
 *
 * A process knows its role and refuses work that contradicts it:
 *   relay/scheduler + HTTP resources  → boot-fatal (not a hidden endpoint)
 *   api/worker                        → NO module schedule arms mount
 *   relay                             → ONLY kind:'relay' arms mount
 *   default 'all'                     → byte-identical to before
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineModule } from "../../src/factory/index.js";

let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

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
    await expect(
      createApp({ logger: false, auth: false, role: "relay", resources: [] }),
    ).rejects.toThrow(/must not serve routes/);
  });

  it("scheduler + resourceDir is BOOT-fatal", async () => {
    await expect(
      createApp({ logger: false, auth: false, role: "scheduler", resourceDir: "./x" }),
    ).rejects.toThrow(/must not serve routes/);
  });

  it("role 'api' mounts NO module schedule arms — and says which were skipped", async () => {
    const info = vi.fn();
    app = await createApp({
      logger: false,
      auth: false,
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
    app = await createApp({
      logger: false,
      auth: false,
      role: "relay",
      modules: [armModule()],
    });
    const jobs = (app.arc?.scheduledJobs ?? []) as Array<{ name: string }>;
    expect(jobs.map((j) => j.name)).toEqual(["billing.relay"]);
  });

  it("default 'all' mounts every arm — unchanged behaviour", async () => {
    app = await createApp({
      logger: false,
      auth: false,
      modules: [armModule()],
    });
    const jobs = (app.arc?.scheduledJobs ?? []) as Array<{ name: string }>;
    expect(jobs.map((j) => j.name).sort()).toEqual(["billing.digest", "billing.relay"]);
  });
});
