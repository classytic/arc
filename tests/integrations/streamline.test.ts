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

function fetchSSE(url: string, timeoutMs = 300): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      const timer = setTimeout(() => {
        res.destroy();
        req.destroy();
        resolve({ statusCode: res.statusCode!, body });
      }, timeoutMs);
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode!, body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
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
