/**
 * Server Accessor Tests
 *
 * Tests that the `server` property on IRequestContext is populated
 * correctly by createRequestContext(), exposing events, audit, and log
 * depending on which plugins are registered.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { auditPlugin } from "../../src/audit/auditPlugin.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { createRequestContext } from "../../src/core/fastifyAdapter.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import type { IRequestContext } from "../../src/types/index.js";

describe("Server Accessor via createRequestContext", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it("server.events exists when eventPlugin is registered", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);
    await app.register(eventPlugin);

    let capturedCtx: IRequestContext | null = null;

    app.get("/test", async (request) => {
      capturedCtx = createRequestContext(request);
      return { ok: true };
    });

    await app.ready();

    await app.inject({ method: "GET", url: "/test" });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx?.server.events).toBeDefined();
    expect(typeof capturedCtx?.server.events?.publish).toBe("function");
  });

  it("server.events is undefined when eventPlugin is not registered", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    let capturedCtx: IRequestContext | null = null;

    app.get("/test", async (request) => {
      capturedCtx = createRequestContext(request);
      return { ok: true };
    });

    await app.ready();

    await app.inject({ method: "GET", url: "/test" });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx?.server.events).toBeUndefined();
  });

  it("server.audit exists when auditPlugin is registered", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);
    await app.register(auditPlugin, { enabled: true, stores: ["memory"] });

    let capturedCtx: IRequestContext | null = null;

    app.get("/test", async (request) => {
      capturedCtx = createRequestContext(request);
      return { ok: true };
    });

    await app.ready();

    await app.inject({ method: "GET", url: "/test" });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx?.server.audit).toBeDefined();
    expect(typeof capturedCtx?.server.audit?.create).toBe("function");
  });

  it("server.log always exists", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    let capturedCtx: IRequestContext | null = null;

    app.get("/test", async (request) => {
      capturedCtx = createRequestContext(request);
      return { ok: true };
    });

    await app.ready();

    await app.inject({ method: "GET", url: "/test" });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx?.server.log).toBeDefined();
  });
});
