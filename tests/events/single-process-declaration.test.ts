/**
 * `singleProcess` — the memory transport as a DECLARED topology.
 *
 * A single-node host (one VPS, on-prem, no Redis budget) is a legitimate
 * production deployment where the memory transport is exactly sufficient:
 * there are no other instances to broadcast to. Before this flag arc could
 * not tell that apart from the accidental default — a multi-replica app that
 * forgot to configure Redis — so it warned on every boot, training exactly
 * the wrong hosts to ignore the log line that mattered.
 *
 * Three regimes, three log outcomes:
 *
 *   memory, undeclared     → WARN (probably a forgotten default; says how to declare)
 *   memory, declared       → INFO (supported config; states the real semantics)
 *   real transport + flag  → WARN (the declaration contradicts the wiring)
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DomainEvent, EventHandler } from "../../src/events/EventTransport.js";
import eventPlugin from "../../src/events/eventPlugin.js";

async function boot(opts: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  const warn = vi.fn();
  const info = vi.fn();
  // Fastify's logger is the observable surface here — override the leaf methods.
  Object.assign(app.log, { warn, info });
  await app.register(eventPlugin, opts);
  await app.ready();
  const text = (calls: ReturnType<typeof vi.fn>["mock"]["calls"]) =>
    calls.map((c) => c.filter((a) => typeof a === "string").join(" ")).join("\n");
  return { app, warnText: text(warn.mock.calls), infoText: text(info.mock.calls) };
}

describe("eventPlugin singleProcess declaration", () => {
  it("memory transport WITHOUT the declaration warns, and names the flag as the fix", async () => {
    const { app, warnText } = await boot({});
    expect(warnText).toContain("in-memory transport");
    // The warn must teach the escape hatch, not just nag.
    expect(warnText).toContain("singleProcess: true");
    await app.close();
  });

  it("memory transport WITH the declaration is an INFO line, not a warning", async () => {
    const { app, warnText, infoText } = await boot({ singleProcess: true });
    expect(warnText).not.toContain("in-memory transport");
    expect(infoText).toContain("declared single-process");
    // The info line still states the true semantics — the flag changes the
    // tone, never the facts.
    expect(infoText).toMatch(/do not survive a crash/);
    // …and points at the durable single-node composition.
    expect(infoText).toContain("createOutboxModule");
    await app.close();
  });

  it("declaring singleProcess alongside a cross-instance transport is called out", async () => {
    const fakeRedis = {
      name: "redis-streams",
      publish: async (_e: DomainEvent) => {},
      subscribe: async (_p: string, _h: EventHandler) => {},
      close: async () => {},
    };
    const { app, warnText } = await boot({ singleProcess: true, transport: fakeRedis });
    expect(warnText).toContain("contradicts");
    expect(warnText).toContain("redis-streams");
    await app.close();
  });

  it("the declaration changes logging only — publish/subscribe behave identically", async () => {
    const { app } = await boot({ singleProcess: true });
    const seen: string[] = [];
    await app.events.subscribe("order.*", async (e) => {
      seen.push(e.type);
    });
    await app.events.publish("order.created", { id: 1 });
    expect(seen).toEqual(["order.created"]);
    await app.close();
  });

  /**
   * The factory path: an EXPLICIT `runtime: 'memory'` on `createApp` IS the
   * single-instance declaration (its JSDoc says so), so it flows down as
   * `singleProcess` — one topology axis, declared once. `runtime` UNSET also
   * resolves to memory stores but must keep the forgotten-default warn, which
   * is why the factory forwards on the literal, not the resolved value.
   *
   * Exercised via `registerArcCore` with a pre-stubbed logger — the events
   * plugin logs during ITS registration, before any `plugins()` callback
   * could install a capture, so `createApp` cannot observe this from outside.
   */
  it("an explicit runtime: 'memory' flows down as the declaration", async () => {
    const { registerArcCore } = await import("../../src/factory/registerArcPlugins.js");
    const app = Fastify({ logger: false });
    const warn = vi.fn();
    const info = vi.fn();
    Object.assign(app.log, { warn, info });
    // biome-ignore lint/suspicious/noExplicitAny: minimal CreateAppOptions slice
    await registerArcCore(app, { runtime: "memory" } as any, () => {});
    await app.ready();

    const all = (calls: ReturnType<typeof vi.fn>["mock"]["calls"]) =>
      calls.map((c) => c.filter((a) => typeof a === "string").join(" ")).join("\n");
    expect(all(warn.mock.calls)).not.toContain("in-memory transport");
    expect(all(info.mock.calls)).toContain("declared single-process");
    await app.close();
  });

  it("runtime UNSET keeps the forgotten-default warn — silence must be earned", async () => {
    const { registerArcCore } = await import("../../src/factory/registerArcPlugins.js");
    const app = Fastify({ logger: false });
    const warn = vi.fn();
    Object.assign(app.log, { warn });
    // biome-ignore lint/suspicious/noExplicitAny: minimal CreateAppOptions slice
    await registerArcCore(app, {} as any, () => {});
    await app.ready();

    const warned = warn.mock.calls
      .map((c) => c.filter((a) => typeof a === "string").join(" "))
      .join("\n");
    expect(warned).toContain("in-memory transport");
    await app.close();
  });
});
