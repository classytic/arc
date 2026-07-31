/**
 * Streamline Integration Tests
 *
 * Tests the Arc <-> Streamline plugin integration:
 * - REST endpoints (start, get, resume, cancel)
 * - v2.1 distributed primitives (idempotencyKey, priority)
 * - Step event bridging (opt-in)
 * - SSE streaming (opt-in)
 * - Auth/permission enforcement
 * - Graceful shutdown
 *
 * Uses mock workflows — does NOT require MongoDB.
 * The integration is tested at the HTTP/plugin boundary, not the engine internals.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowLike,
  WorkflowRunLike,
  WorkflowStartOptions,
} from "../../src/integrations/streamline.js";
import { streamlinePlugin } from "../../src/integrations/streamline.js";

// ============================================================================
// Mock Factory
// ============================================================================

function createMockRun(overrides?: Partial<WorkflowRunLike>): WorkflowRunLike {
  return {
    _id: `run-${Date.now()}`,
    workflowId: "test-workflow",
    status: "running",
    createdAt: new Date(),
    updatedAt: new Date(),
    steps: {},
    ...overrides,
  };
}

function createMockWorkflow(id = "test-workflow", overrides?: Partial<WorkflowLike>): WorkflowLike {
  const eventBus = new EventEmitter();
  const runs = new Map<string, WorkflowRunLike>();

  const wf: WorkflowLike = {
    definition: { id, name: `Test ${id}`, steps: { step1: {}, step2: {} } },
    engine: {
      start: vi.fn(async (input: unknown, options?: WorkflowStartOptions) => {
        const run = createMockRun({
          _id: `run-${Math.random().toString(36).slice(2, 8)}`,
          workflowId: id,
          input,
          idempotencyKey: options?.idempotencyKey,
          priority: options?.priority ?? 0,
        });
        runs.set(run._id, run);
        return run;
      }),
      execute: vi.fn(async (runId: string) => runs.get(runId)!),
      resume: vi.fn(async (runId: string) => {
        const run = runs.get(runId);
        if (run) run.status = "running";
        return run!;
      }),
      cancel: vi.fn(async (runId: string) => {
        const run = runs.get(runId);
        if (run) run.status = "cancelled";
        return run!;
      }),
      get: vi.fn(async (runId: string) => runs.get(runId) ?? null),
      pause: vi.fn(async (runId: string) => {
        const run = runs.get(runId);
        if (run) (run as WorkflowRunLike & { paused?: boolean }).paused = true;
        return run!;
      }),
      rewindTo: vi.fn(async (runId: string) => runs.get(runId)!),
      shutdown: vi.fn(),
    },
    start: vi.fn(async (input: unknown, options?: WorkflowStartOptions) => {
      const run = createMockRun({
        _id: `run-${Math.random().toString(36).slice(2, 8)}`,
        workflowId: id,
        input,
        idempotencyKey: options?.idempotencyKey,
        priority: options?.priority ?? 0,
      });
      runs.set(run._id, run);
      return run;
    }),
    resume: vi.fn(async (runId: string, _payload?: unknown) => {
      const run = runs.get(runId);
      if (run) run.status = "running";
      return run!;
    }),
    cancel: vi.fn(async (runId: string) => {
      const run = runs.get(runId);
      if (run) run.status = "cancelled";
      return run!;
    }),
    get: vi.fn(async (runId: string) => runs.get(runId) ?? null),
    shutdown: vi.fn(),
    container: { eventBus },
    ...overrides,
  };

  return wf;
}

// ============================================================================
// SSE Helper
// ============================================================================

/**
 * Read an SSE stream.
 *
 * Returns `connected` — resolved once the response headers arrive, i.e. the
 * subscription actually exists server-side. A test that emits before that races
 * the subscribe and loses the frame; sleeping "long enough" first is the same
 * guess that flakes under load.
 *
 * `until` ends the read as soon as the body carries what is being asserted, so
 * `timeoutMs` is a ceiling rather than the cost of every run.
 */
function fetchSSE(
  url: string,
  timeoutMs = 300,
  until?: (body: string) => boolean,
): Promise<{ statusCode: number; body: string }> & { connected: Promise<void> } {
  let markConnected: () => void = () => {};
  const connected = new Promise<void>((r) => {
    markConnected = r;
  });
  const promise = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      markConnected();
      const timer = setTimeout(() => {
        res.destroy();
        req.destroy();
        resolve({ statusCode: res.statusCode!, body });
      }, timeoutMs);
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (until?.(body)) {
          clearTimeout(timer);
          res.destroy();
          req.destroy();
          resolve({ statusCode: res.statusCode!, body });
        }
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode!, body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
  return Object.assign(promise, { connected });
}

// ============================================================================
// Tests
// ============================================================================

describe("Streamline Integration Plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  // ---------- REST Endpoints ----------

  describe("REST endpoints", () => {
    it("should register start/get/resume/cancel/list routes", async () => {
      const wf = createMockWorkflow("orders");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
      });
      await app.ready();

      // Start (default prefix: /workflows)
      const startRes = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: { orderId: "123" } },
      });
      expect(startRes.statusCode).toBe(201);
      const run = startRes.json();
      expect(run._id).toBeDefined();
      expect(run.workflowId).toBe("orders");

      // Get
      const getRes = await app.inject({
        method: "GET",
        url: `/workflows/orders/runs/${run._id}`,
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json()._id).toBe(run._id);

      // Resume
      const resumeRes = await app.inject({
        method: "POST",
        url: `/workflows/orders/runs/${run._id}/resume`,
        payload: { payload: { approved: true } },
      });
      expect(resumeRes.statusCode).toBe(200);

      // Cancel
      const cancelRes = await app.inject({
        method: "POST",
        url: `/workflows/orders/runs/${run._id}/cancel`,
      });
      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().status).toBe("cancelled");

      // List
      const listRes = await app.inject({
        method: "GET",
        url: "/workflows",
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toHaveLength(1);
      expect(listRes.json()[0].id).toBe("orders");
    });

    it("rejects /start with unknown top-level keys and a 422 + actionable message", async () => {
      // The classic mistake: caller sends `{ orderId: '123' }` instead of
      // wrapping in `{ input: { orderId: '123' } }`. Pre-2.16 this 400'd
      // somewhere downstream with "Invalid Date" or similar. The envelope
      // check inside `/start` catches it at the route boundary.
      const wf = createMockWorkflow("orders");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { orderId: "123", amount: 99 },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.code).toBe("arc.streamline.missing_input_envelope");
      expect(body.message).toContain("'{ input: {...} }'");
      expect(body.message).toContain("orderId");
      // The mock workflow's start() should NOT have been called — the
      // request never reaches the engine.
      expect(wf.start).not.toHaveBeenCalled();
    });

    it("rejects /start with extra keys alongside an `input` envelope (422)", async () => {
      // Caller put `meta` correctly but also smuggled `note` at the top
      // level — surface that explicitly so the field doesn't get silently
      // dropped on its way to the engine.
      const wf = createMockWorkflow("orders");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: { orderId: "123" }, note: "stray" },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.code).toBe("arc.streamline.unknown_envelope_keys");
      expect(body.message).toContain("note");
      expect(wf.start).not.toHaveBeenCalled();
    });

    it("accepts /start with no body (workflow with no input)", async () => {
      // Some workflows are parameterless — the envelope check must not
      // reject the empty-body case.
      const wf = createMockWorkflow("ping");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/workflows/ping/start",
      });
      expect(res.statusCode).toBe(201);
      expect(wf.start).toHaveBeenCalledTimes(1);
    });

    it("should return 404 for unknown run", async () => {
      const wf = createMockWorkflow("wf1");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
      });
      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/workflows/wf1/runs/nonexistent",
      });
      expect(res.statusCode).toBe(404);
    });

    it("should reject duplicate workflow IDs", async () => {
      const wf1 = createMockWorkflow("dup");
      const wf2 = createMockWorkflow("dup");
      app = Fastify({ logger: false });

      await expect(
        app.register(streamlinePlugin, {
          workflows: [wf1, wf2],
          auth: false,
        }),
      ).rejects.toThrow("Duplicate workflow ID");
    });
  });

  // ---------- v2.1 Distributed Primitives ----------

  describe("v2.1 StartOptions passthrough", () => {
    it("should pass idempotencyKey and priority to workflow.start()", async () => {
      const wf = createMockWorkflow("payments");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
      });
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/workflows/payments/start",
        payload: {
          input: { amount: 100 },
          idempotencyKey: "pay:order-1",
          priority: 5,
        },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json();
      expect(data.idempotencyKey).toBe("pay:order-1");
      expect(data.priority).toBe(5);

      // Verify the mock was called with options
      expect(wf.start).toHaveBeenCalledWith(
        { amount: 100 },
        expect.objectContaining({
          idempotencyKey: "pay:order-1",
          priority: 5,
        }),
      );
    });

    it("should work without StartOptions (backwards compat)", async () => {
      const wf = createMockWorkflow("simple");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
      });
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/workflows/simple/start",
        payload: { input: { data: "test" } },
      });

      expect(res.statusCode).toBe(201);
      expect(wf.start).toHaveBeenCalledWith({ data: "test" }, expect.objectContaining({}));
    });
  });

  // ---------- Event Bridging ----------

  describe("Event bridging", () => {
    it("should bridge workflow events to Arc event bus when bridgeEvents=true", async () => {
      const wf = createMockWorkflow("evented");
      const published: Array<{ type: string; payload: unknown }> = [];

      app = Fastify({ logger: false });
      // Simulate Arc event bus
      app.decorate("events", {
        publish: vi.fn(async (type: string, payload: unknown) => {
          published.push({ type, payload });
        }),
      });

      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        bridgeEvents: true,
      });
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/workflows/evented/start",
        payload: { input: {} },
      });

      expect(published.some((e) => e.type === "workflow.evented.started")).toBe(true);
    });

    it("should NOT bridge events when bridgeEvents=false", async () => {
      const wf = createMockWorkflow("silent");
      const published: unknown[] = [];

      app = Fastify({ logger: false });
      app.decorate("events", {
        publish: vi.fn(async (_t: string, p: unknown) => published.push(p)),
      });

      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        bridgeEvents: false,
      });
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/workflows/silent/start",
        payload: { input: {} },
      });

      expect(published).toHaveLength(0);
    });
  });

  // ---------- Step Event Bridging (opt-in) ----------

  describe("Step event bridging (bridgeBusEvents)", () => {
    it("should bridge step events to Arc bus when enabled", async () => {
      const wf = createMockWorkflow("step-bridge");
      const published: Array<{ type: string; payload: unknown }> = [];

      app = Fastify({ logger: false });
      app.decorate("events", {
        publish: vi.fn(async (type: string, payload: unknown) => {
          published.push({ type, payload });
        }),
      });

      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        bridgeBusEvents: true,
      });
      await app.ready();

      // Simulate streamline emitting a step event
      wf.container?.eventBus.emit("step:completed", {
        runId: "r1",
        stepId: "step1",
      });

      // Allow async event propagation
      await new Promise((r) => setTimeout(r, 50));

      expect(published.some((e) => e.type === "workflow.step-bridge.step:completed")).toBe(true);
    });

    it("should NOT bridge step events when disabled (default)", async () => {
      const wf = createMockWorkflow("no-step-bridge");
      const published: unknown[] = [];

      app = Fastify({ logger: false });
      app.decorate("events", {
        publish: vi.fn(async (_t: string, p: unknown) => published.push(p)),
      });

      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        bridgeBusEvents: false,
      });
      await app.ready();

      wf.container?.eventBus.emit("step:completed", { runId: "r1", stepId: "s1" });
      await new Promise((r) => setTimeout(r, 50));

      expect(published).toHaveLength(0);
    });
  });

  // ---------- SSE Streaming (opt-in) ----------

  describe("SSE streaming (enableStreaming)", () => {
    it("should stream step events via SSE when enabled", async () => {
      const wf = createMockWorkflow("sse-wf");
      // Pre-populate a run so GET finds it
      const run = await wf.start({});

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        enableStreaming: true,
      });
      await app.listen({ port: 0 });
      const port = (app.server.address() as { port: number }).port;

      // Start SSE connection (non-blocking)
      const ssePromise = fetchSSE(
        `http://127.0.0.1:${port}/workflows/sse-wf/runs/${run._id}/stream`,
        400,
      );

      // Give SSE time to connect
      await new Promise((r) => setTimeout(r, 50));

      // Emit step events
      wf.container?.eventBus.emit("step:completed", {
        runId: run._id,
        stepId: "step1",
        data: { result: "ok" },
      });

      const sse = await ssePromise;
      expect(sse.statusCode).toBe(200);
      expect(sse.body).toContain("event: step:completed");
      expect(sse.body).toContain(run._id);
    });

    it("should NOT register SSE route when disabled (default)", async () => {
      const wf = createMockWorkflow("no-sse");

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        enableStreaming: false,
      });
      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/workflows/no-sse/runs/some-id/stream",
      });
      expect(res.statusCode).toBe(404);
    });

    it("should filter SSE events by runId", async () => {
      const wf = createMockWorkflow("sse-filter");
      const run1 = await wf.start({});
      const run2 = await wf.start({});

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        enableStreaming: true,
      });
      await app.listen({ port: 0 });
      const port = (app.server.address() as { port: number }).port;

      const ssePromise = fetchSSE(
        `http://127.0.0.1:${port}/workflows/sse-filter/runs/${run1._id}/stream`,
        400,
      );

      await new Promise((r) => setTimeout(r, 50));

      // Emit event for run2 (should be filtered out)
      wf.container?.eventBus.emit("step:completed", {
        runId: run2._id,
        stepId: "s1",
      });
      // Emit event for run1 (should be included)
      wf.container?.eventBus.emit("step:completed", {
        runId: run1._id,
        stepId: "s1",
      });

      const sse = await ssePromise;
      expect(sse.body).toContain(run1._id);
      expect(sse.body).not.toContain(run2._id);
    });

    it("flushes head + sends a snapshot on connect with ZERO bus events (regression: 0-byte stream)", async () => {
      // Before the fix, the handler wrote the head but never flushed it and
      // only wrote on a live bus event — so connecting during a quiet/long
      // step (or after completion) yielded an empty body and the client's
      // EventSource `onopen` never fired. The snapshot + flushHeaders make
      // the stream observably alive the instant it connects.
      const wf = createMockWorkflow("sse-snapshot");
      const run = await wf.start({}); // status: 'running' (non-terminal)

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        enableStreaming: true,
      });
      await app.listen({ port: 0 });
      const port = (app.server.address() as { port: number }).port;

      // Emit NOTHING. A short read window proves bytes arrive on connect.
      const sse = await fetchSSE(
        `http://127.0.0.1:${port}/workflows/sse-snapshot/runs/${run._id}/stream`,
        200,
      );

      expect(sse.statusCode).toBe(200);
      expect(sse.body).toContain("event: workflow:snapshot");
      expect(sse.body).toContain(run._id);
    });

    it("snapshots then closes immediately for an already-terminal run", async () => {
      // A subscriber that joins after the run finished must not hang: the
      // handler sends the snapshot and ends the response (no future events
      // will ever fire for a terminal run).
      const wf = createMockWorkflow("sse-terminal");
      const run = await wf.start({});
      run.status = "done"; // terminal at connect time

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        enableStreaming: true,
      });
      await app.listen({ port: 0 });
      const port = (app.server.address() as { port: number }).port;

      const t0 = Date.now();
      const sse = await fetchSSE(
        `http://127.0.0.1:${port}/workflows/sse-terminal/runs/${run._id}/stream`,
        1500,
      );
      const elapsed = Date.now() - t0;

      expect(sse.statusCode).toBe(200);
      expect(sse.body).toContain("event: workflow:snapshot");
      expect(sse.body).toContain('"status":"done"');
      // Resolved via the server ending the response, NOT the 1500ms read
      // timeout — proves the terminal-on-connect close path fired.
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ---------- Permissions ----------

  describe("Permissions", () => {
    it("should enforce per-operation permissions", async () => {
      const wf = createMockWorkflow("protected");

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        permissions: {
          start: async () => false, // Block all starts
          get: async () => true,
        },
      });
      await app.ready();

      const startRes = await app.inject({
        method: "POST",
        url: "/workflows/protected/start",
        payload: { input: {} },
      });
      expect(startRes.statusCode).toBe(403);

      // But get should work
      const run = await wf.start({});
      const getRes = await app.inject({
        method: "GET",
        url: `/workflows/protected/runs/${run._id}`,
      });
      expect(getRes.statusCode).toBe(200);
    });
  });

  // ---------- Shutdown ----------

  describe("Graceful shutdown", () => {
    it("should call shutdown on all workflows when app closes", async () => {
      const wf1 = createMockWorkflow("wf1");
      const wf2 = createMockWorkflow("wf2");

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf1, wf2],
        auth: false,
      });
      await app.ready();

      await app.close();

      expect(wf1.shutdown).toHaveBeenCalledOnce();
      expect(wf2.shutdown).toHaveBeenCalledOnce();
    });
  });

  // ---------- Custom prefix (regression: duplicate-prefix bug) ----------

  describe("Custom prefix", () => {
    it("registers routes ONCE under the custom prefix (no double-prefix)", async () => {
      const wf = createMockWorkflow("orders");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        prefix: "/api/workflows",
        workflows: [wf],
        auth: false,
      });
      await app.ready();

      // Routes must register at /api/workflows/orders/start, NOT at
      // /api/workflows/api/workflows/orders/start. Fastify already scopes
      // the plugin under the register-time `prefix`; the plugin must NOT
      // also prepend `options.prefix` to the route paths it builds.
      const ok = await app.inject({
        method: "POST",
        url: "/api/workflows/orders/start",
        payload: { input: { orderId: "1" } },
      });
      expect(ok.statusCode).toBe(201);

      const doubled = await app.inject({
        method: "POST",
        url: "/api/workflows/api/workflows/orders/start",
        payload: { input: { orderId: "1" } },
      });
      expect(doubled.statusCode).toBe(404);
    });

    it("default prefix still works without explicit register prefix", async () => {
      const wf = createMockWorkflow("orders");
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const ok = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: { orderId: "1" } },
      });
      expect(ok.statusCode).toBe(201);
    });
  });

  // ---------- DELETE endpoint (operator escape hatch for stuck runs) ----------

  describe("DELETE /:workflowId/runs/:runId", () => {
    function workflowWithRepo(opts?: { tenantOwner?: string }): {
      wf: WorkflowLike;
      deleteCalls: Array<{ id: string; options?: Record<string, unknown> }>;
      getByIdCalls: Array<{ id: string; options?: Record<string, unknown> }>;
    } {
      const wf = createMockWorkflow("orders");
      const deleteCalls: Array<{ id: string; options?: Record<string, unknown> }> = [];
      const getByIdCalls: Array<{ id: string; options?: Record<string, unknown> }> = [];
      const tenantOwner = opts?.tenantOwner;
      wf.container = {
        ...wf.container!,
        repository: {
          getAll: vi.fn(async () => ({ data: [], total: 0 })),
          getById: vi.fn(async (id: string, options?: Record<string, unknown>) => {
            getByIdCalls.push({ id, options });
            // Existence backed by the workflow's internal run map (via
            // `wf.get`). Layer the tenant-filter on top: row visible only
            // when the caller's tenantId matches the row's owner (or
            // `bypassTenant`, or no owner configured for the test).
            const exists = await wf.get(id);
            if (!exists) return null;
            if (options?.bypassTenant) return exists;
            if (tenantOwner === undefined) return exists;
            if (options?.tenantId === tenantOwner) return exists;
            return null;
          }),
          delete: vi.fn(async (id: string, options?: Record<string, unknown>) => {
            deleteCalls.push({ id, options });
            return { acknowledged: true };
          }),
        },
      };
      return { wf, deleteCalls, getByIdCalls };
    }

    it("cancels-then-deletes a run and returns 204", async () => {
      const { wf, deleteCalls } = workflowWithRepo();
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const start = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: {} },
      });
      const runId = start.json()._id as string;

      const del = await app.inject({
        method: "DELETE",
        url: `/workflows/orders/runs/${runId}`,
      });
      expect(del.statusCode).toBe(204);
      expect(wf.cancel).toHaveBeenCalledWith(runId);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]?.id).toBe(runId);
    });

    it("returns 404 when the run does not exist", async () => {
      const { wf } = workflowWithRepo();
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const del = await app.inject({
        method: "DELETE",
        url: "/workflows/orders/runs/nonexistent",
      });
      expect(del.statusCode).toBe(404);
    });

    it("forwards tenantId when the resolver supplies one", async () => {
      const { wf, deleteCalls, getByIdCalls } = workflowWithRepo();
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        tenantResolver: () => "org-7",
      });
      await app.ready();

      const start = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: {} },
      });
      const runId = start.json()._id as string;

      await app.inject({ method: "DELETE", url: `/workflows/orders/runs/${runId}` });
      expect(deleteCalls[0]?.options).toEqual({ tenantId: "org-7" });
      // Pre-flight existence check must also be tenant-scoped — that's
      // the load-bearing security invariant for the DELETE handler.
      expect(getByIdCalls[0]?.options).toEqual({ tenantId: "org-7" });
    });

    it("works with a real (this-using) repository — does not call methods unbound [regression]", async () => {
      // The handler used to destructure `repo.getById` / `repo.delete` and call
      // them detached. The vi.fn mocks above are arrow-bound, so the bug hid.
      // A real mongokit `Repository`'s methods use `this` (`this._buildContext`)
      // and throw "Cannot read properties of undefined" when called unbound —
      // reproduced here with a plain `this`-using object.
      const wf = createMockWorkflow("orders");
      const repo = {
        _live: true,
        async getById(id: string) {
          return this._live ? { _id: id } : null; // bare `this.` → throws if unbound
        },
        async delete(_id: string) {
          return this._live ? { acknowledged: true } : null;
        },
        async getAll() {
          return { data: [], total: 0 };
        },
      };
      wf.container = {
        eventBus: { on() {}, off() {} },
        repository: repo as never,
      };

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const start = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: {} },
      });
      const runId = start.json()._id as string;

      const del = await app.inject({
        method: "DELETE",
        url: `/workflows/orders/runs/${runId}`,
      });
      expect(del.statusCode).toBe(204); // 500 ("…reading '_live'") before the bind fix
    });

    it("returns 404 for a cross-tenant runId (no existence leak)", async () => {
      // Row belongs to org-A; caller is from org-B. Even though the runId
      // is correct AND the run physically exists, the tenant-scoped
      // pre-flight must hide the row.
      const { wf, deleteCalls } = workflowWithRepo({ tenantOwner: "org-A" });
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf],
        auth: false,
        tenantResolver: () => "org-B",
      });
      await app.ready();

      // Start the run as org-A so it exists in the workflow's run map.
      const start = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: {} },
      });
      const runId = start.json()._id as string;

      const del = await app.inject({
        method: "DELETE",
        url: `/workflows/orders/runs/${runId}`,
      });
      expect(del.statusCode).toBe(404);
      // Critically: delete must NOT have been called. The handler must
      // bail at the pre-flight; only then is the 404 honest.
      expect(deleteCalls).toHaveLength(0);
    });

    it("does not register the route when the repository has no delete method", async () => {
      const wf = createMockWorkflow("orders");
      // No repository on container
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const del = await app.inject({
        method: "DELETE",
        url: "/workflows/orders/runs/r1",
      });
      expect(del.statusCode).toBe(404);
    });

    it("does not register the route when the repository has no getById method", async () => {
      // Pre-flight is the load-bearing security gate — without getById
      // we'd be falling back to a non-tenant-scoped read, so the route
      // refuses to mount.
      const wf = createMockWorkflow("orders");
      wf.container = {
        ...wf.container!,
        repository: {
          getAll: vi.fn(async () => ({ data: [], total: 0 })),
          delete: vi.fn(async () => ({ acknowledged: true })),
          // getById omitted on purpose
        },
      };
      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, { workflows: [wf], auth: false });
      await app.ready();

      const del = await app.inject({
        method: "DELETE",
        url: "/workflows/orders/runs/r1",
      });
      expect(del.statusCode).toBe(404);
    });
  });

  // ---------- Multiple Workflows ----------

  describe("Multiple workflows", () => {
    it("should register separate routes per workflow", async () => {
      const wf1 = createMockWorkflow("orders");
      const wf2 = createMockWorkflow("payments");

      app = Fastify({ logger: false });
      await app.register(streamlinePlugin, {
        workflows: [wf1, wf2],
        auth: false,
      });
      await app.ready();

      const listRes = await app.inject({ method: "GET", url: "/workflows" });
      expect(listRes.json()).toHaveLength(2);

      const r1 = await app.inject({
        method: "POST",
        url: "/workflows/orders/start",
        payload: { input: {} },
      });
      expect(r1.statusCode).toBe(201);
      expect(r1.json().workflowId).toBe("orders");

      const r2 = await app.inject({
        method: "POST",
        url: "/workflows/payments/start",
        payload: { input: {} },
      });
      expect(r2.statusCode).toBe(201);
      expect(r2.json().workflowId).toBe("payments");
    });
  });
});

// ============================================================================
// v2.18: streamline 2.6 surface — SSE stream frames + tenant-scoped per-run
// ============================================================================

describe("SSE delivers ctx.stream frames (streamline >= 2.6)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("forwards step:stream frames on the SSE endpoint, run-scoped", async () => {
    const wf = createMockWorkflow("ai");
    app = Fastify({ logger: false });
    await app.register(streamlinePlugin, {
      workflows: [wf],
      auth: false,
      enableStreaming: true,
    });
    await app.ready();
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;

    const run = await wf.start({ prompt: "hi" });

    // Ends on the awaited frame; waits for the SUBSCRIPTION rather than guessing
    // it is ready after 60ms, which loses the frame whenever the pool is busy.
    const ssePromise = fetchSSE(
      `http://localhost:${port}/workflows/ai/runs/${run._id}/stream`,
      3000,
      (body) => body.includes('"token":"hel"'),
    );
    await ssePromise.connected;

    // Frame for THIS run — must be delivered.
    (wf.container!.eventBus as EventEmitter).emit("step:stream", {
      runId: run._id,
      stepId: "generate",
      seq: 0,
      frame: { token: "hel" },
    });
    // Frame for ANOTHER run — must be filtered out.
    (wf.container!.eventBus as EventEmitter).emit("step:stream", {
      runId: "other-run",
      stepId: "generate",
      seq: 0,
      frame: { token: "nope" },
    });

    const { body } = await ssePromise;
    expect(body).toContain("event: step:stream");
    expect(body).toContain('"token":"hel"');
    expect(body).not.toContain('"token":"nope"');
  });

  it("does NOT republish step:stream onto arc's transport via bridgeBusEvents", async () => {
    const wf = createMockWorkflow("ai");
    const published: string[] = [];
    app = Fastify({ logger: false });
    app.decorate("events", {
      publish: vi.fn(async (topic: string) => {
        published.push(topic);
      }),
    });
    await app.register(streamlinePlugin, {
      workflows: [wf],
      auth: false,
      bridgeBusEvents: true,
    });
    await app.ready();

    (wf.container!.eventBus as EventEmitter).emit("step:stream", {
      runId: "r1",
      stepId: "s1",
      seq: 0,
      frame: { token: "x" },
    });
    (wf.container!.eventBus as EventEmitter).emit("step:completed", {
      runId: "r1",
      stepId: "s1",
    });
    await new Promise((r) => setTimeout(r, 30));

    // Lifecycle events bridge; high-frequency frames deliberately don't.
    expect(published).toContain("workflow.ai.step:completed");
    expect(published.some((t) => t.includes("step:stream"))).toBe(false);
  });
});

describe("tenant-scoped per-run pre-flight (cross-tenant 404)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  /** Mock workflow whose repository.getById respects tenant scope. */
  function createTenantWorkflow(ownerTenant: string) {
    const wf = createMockWorkflow("billing");
    const baseGet = wf.get as ReturnType<typeof vi.fn>;
    wf.container!.repository = {
      getAll: vi.fn(async () => ({ data: [] })),
      // Tenant-scoped read: only the owning tenant sees the run.
      getById: vi.fn(async (id: string, opts?: Record<string, unknown>) => {
        if (opts?.tenantId !== undefined && opts.tenantId !== ownerTenant) return null;
        return (await baseGet(id)) as WorkflowRunLike | null;
      }),
    };
    return wf;
  }

  it("returns 404 on every per-run route for a foreign tenant, 200 for the owner", async () => {
    const wf = createTenantWorkflow("org-a");
    app = Fastify({ logger: false });
    await app.register(streamlinePlugin, {
      workflows: [wf],
      auth: false,
      tenantResolver: (req) => req.headers["x-org"] as string | undefined,
    });
    await app.ready();

    const run = await wf.start({});

    const perRunRoutes: Array<{ method: "GET" | "POST"; url: string; payload?: unknown }> = [
      { method: "GET", url: `/workflows/billing/runs/${run._id}` },
      { method: "POST", url: `/workflows/billing/runs/${run._id}/resume`, payload: {} },
      { method: "POST", url: `/workflows/billing/runs/${run._id}/cancel` },
      { method: "POST", url: `/workflows/billing/runs/${run._id}/execute` },
      { method: "POST", url: `/workflows/billing/runs/${run._id}/pause` },
      {
        method: "POST",
        url: `/workflows/billing/runs/${run._id}/rewind`,
        payload: { stepId: "step1" },
      },
    ];

    // Foreign tenant: clean 404 on every route (no existence leak).
    for (const r of perRunRoutes) {
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers: { "x-org": "org-b" },
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url} (foreign tenant)`).toBe(404);
    }

    // Owning tenant: pre-flight passes, handlers run.
    const ownerGet = await app.inject({
      method: "GET",
      url: `/workflows/billing/runs/${run._id}`,
      headers: { "x-org": "org-a" },
    });
    expect(ownerGet.statusCode).toBe(200);
    expect(ownerGet.json()._id).toBe(run._id);
  });

  it("skips the pre-flight when no tenantResolver is configured (behavior unchanged)", async () => {
    const wf = createTenantWorkflow("org-a");
    app = Fastify({ logger: false });
    await app.register(streamlinePlugin, { workflows: [wf], auth: false });
    await app.ready();

    const run = await wf.start({});
    const res = await app.inject({ method: "GET", url: `/workflows/billing/runs/${run._id}` });
    expect(res.statusCode).toBe(200);
  });

  it("bypassTenant requests skip the ownership gate (admin path)", async () => {
    const wf = createTenantWorkflow("org-a");
    app = Fastify({ logger: false });
    await app.register(streamlinePlugin, {
      workflows: [wf],
      auth: false,
      tenantResolver: (req) => req.headers["x-org"] as string | undefined,
      bypassTenantResolver: (req) => req.headers["x-admin"] === "1",
    });
    await app.ready();

    const run = await wf.start({});
    const res = await app.inject({
      method: "GET",
      url: `/workflows/billing/runs/${run._id}`,
      headers: { "x-org": "org-b", "x-admin": "1" },
    });
    expect(res.statusCode).toBe(200);
  });
});
