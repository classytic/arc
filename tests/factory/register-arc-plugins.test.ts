/**
 * registerArcPlugins — Unit Tests
 *
 * Tests registerArcCore and registerArcPlugins in isolation.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerArcCore, registerArcPlugins } from "../../src/factory/registerArcPlugins.js";
import type { CreateAppOptions } from "../../src/factory/types.js";

function createTestFastify(): FastifyInstance {
  return Fastify({ logger: false });
}

describe("registerArcCore", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("decorates fastify.arc", async () => {
    app = createTestFastify();
    const tracked: string[] = [];
    await registerArcCore(app, {}, (name) => tracked.push(name));
    await app.ready();

    expect(app.arc).toBeDefined();
    expect(app.arc.plugins).toBeDefined();
    expect(tracked).toContain("arc-core");
  });

  it("registers events plugin by default", async () => {
    app = createTestFastify();
    const tracked: string[] = [];
    await registerArcCore(app, {}, (name) => tracked.push(name));
    await app.ready();

    expect(app.events).toBeDefined();
    expect(app.events.transportName).toBeDefined();
    expect(tracked).toContain("arc-events");
  });

  it("skips events when events: false", async () => {
    app = createTestFastify();
    const tracked: string[] = [];
    await registerArcCore(app, { arcPlugins: { events: false } }, (name) => tracked.push(name));
    await app.ready();

    expect(tracked).not.toContain("arc-events");
  });
});

describe("registerArcPlugins", () => {
  let app: FastifyInstance;

  async function setupWithCore(config: CreateAppOptions = {}): Promise<string[]> {
    app = createTestFastify();
    const tracked: string[] = [];
    const track = (name: string) => tracked.push(name);
    const modules = await registerArcCore(app, config, track);
    await registerArcPlugins(app, config, track, modules);
    await app.ready();
    return tracked;
  }

  afterEach(async () => {
    if (app) await app.close();
  });

  it("registers requestId, health, gracefulShutdown by default", async () => {
    const tracked = await setupWithCore();

    expect(tracked).toContain("arc-request-id");
    expect(tracked).toContain("arc-health");
    expect(tracked).toContain("arc-graceful-shutdown");
  });

  it("skips requestId when disabled", async () => {
    const tracked = await setupWithCore({
      arcPlugins: { requestId: false },
    });

    expect(tracked).not.toContain("arc-request-id");
  });

  it("skips health when disabled", async () => {
    const tracked = await setupWithCore({
      arcPlugins: { health: false },
    });

    expect(tracked).not.toContain("arc-health");
  });

  it("skips gracefulShutdown when disabled", async () => {
    const tracked = await setupWithCore({
      arcPlugins: { gracefulShutdown: false },
    });

    expect(tracked).not.toContain("arc-graceful-shutdown");
  });

  it("registers caching when enabled", async () => {
    const tracked = await setupWithCore({
      arcPlugins: { caching: true },
    });

    expect(tracked).toContain("arc-caching");
  });

  it("registers queryCache when enabled", async () => {
    const tracked = await setupWithCore({
      arcPlugins: { queryCache: true },
    });

    expect(tracked).toContain("arc-query-cache");
  });

  it("registers metrics when enabled", async () => {
    const tracked = await setupWithCore({
      arcPlugins: { metrics: true },
    });

    expect(tracked).toContain("arc-metrics");
  });

  it("does not register caching/sse/metrics/queryCache by default", async () => {
    const tracked = await setupWithCore();

    expect(tracked).not.toContain("arc-caching");
    expect(tracked).not.toContain("arc-sse");
    expect(tracked).not.toContain("arc-metrics");
    expect(tracked).not.toContain("arc-query-cache");
  });

  it("all plugins disabled = only core", async () => {
    const tracked = await setupWithCore({
      arcPlugins: {
        requestId: false,
        health: false,
        gracefulShutdown: false,
      },
    });

    expect(tracked).toEqual(["arc-core", "arc-events"]);
  });
});
