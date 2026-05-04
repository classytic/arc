/**
 * v2.11.0 — streamline 2.2 event bridging regressions.
 *
 * Arc's streamline integration was written against streamline 2.1 and
 * bridged 5 step-level events + streamed 7 via SSE. Streamline 2.2
 * expanded its event bus to 19 events total (7 step + 9 workflow + 3
 * engine/scheduler). This file locks in arc's 2.11 expansion:
 *
 *   - `bridgeBusEvents` (canonical) bridges all 19 events to arc's bus
 *     (the deprecated `bridgeStepEvents` alias was removed in 2.13)
 *   - SSE streams all 19 events, auto-closes only on the 3 terminal ones
 *   - Engine-level events (no runId) flow through per-stream unfiltered
 *   - Loose coupling: subscribing to unknown events is safe (no-op on
 *     the EventEmitter); future streamline releases that add events
 *     don't break arc, and arc's frozen list is extended by editing
 *     `STREAMLINE_BUS_EVENTS`.
 *
 * See `src/integrations/streamline.ts`.
 */

import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STREAMLINE_BUS_EVENTS,
  STREAMLINE_TERMINAL_EVENTS,
  streamlinePlugin,
  type WorkflowLike,
  type WorkflowRunLike,
} from "../../src/integrations/streamline.js";

// ============================================================================
// Shared mock
// ============================================================================

function createMockRun(id: string, workflowId: string, status = "running"): WorkflowRunLike {
  return { _id: id, workflowId, status, createdAt: new Date(), updatedAt: new Date() };
}

function createMockWorkflow(id = "wf"): WorkflowLike {
  const eventBus = new EventEmitter();
  const runs = new Map<string, WorkflowRunLike>();

  const wf: WorkflowLike = {
    definition: { id, name: id, steps: {} },
    engine: {
      start: vi.fn(async () => {
        const run = createMockRun(`run-${runs.size + 1}`, id);
        runs.set(run._id, run);
        return run;
      }),
      execute: vi.fn(async (runId: string) => runs.get(runId)!),
      resume: vi.fn(async (runId: string) => runs.get(runId)!),
      cancel: vi.fn(async (runId: string) => runs.get(runId)!),
      get: vi.fn(async (runId: string) => runs.get(runId) ?? null),
    },
    start: vi.fn(async () => {
      const run = createMockRun(`run-${runs.size + 1}`, id);
      runs.set(run._id, run);
      return run;
    }),
    resume: vi.fn(async (runId: string) => runs.get(runId)!),
    cancel: vi.fn(async (runId: string) => runs.get(runId)!),
    get: vi.fn(async (runId: string) => runs.get(runId) ?? null),
    container: {
      eventBus: {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          eventBus.on(event, listener);
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          eventBus.off(event, listener);
        },
      },
    },
  };
  // Expose the inner bus for test emits
  (wf as WorkflowLike & { _innerBus: EventEmitter })._innerBus = eventBus;
  return wf;
}

// ============================================================================
// Exported constants
// ============================================================================

describe("v2.11.0 — STREAMLINE_BUS_EVENTS constant covers streamline 2.2's full bus surface", () => {
  it("includes all 7 step events", () => {
    expect(STREAMLINE_BUS_EVENTS).toEqual(
      expect.arrayContaining([
        "step:started",
        "step:completed",
        "step:failed",
        "step:waiting",
        "step:skipped",
        "step:retry-scheduled",
        "step:compensated",
      ]),
    );
  });

  it("includes all 9 workflow events", () => {
    expect(STREAMLINE_BUS_EVENTS).toEqual(
      expect.arrayContaining([
        "workflow:started",
        "workflow:completed",
        "workflow:failed",
        "workflow:waiting",
        "workflow:resumed",
        "workflow:cancelled",
        "workflow:recovered",
        "workflow:retry",
        "workflow:compensating",
      ]),
    );
  });

  it("includes all 3 engine/scheduler telemetry events", () => {
    expect(STREAMLINE_BUS_EVENTS).toEqual(
      expect.arrayContaining(["engine:error", "scheduler:error", "scheduler:circuit-open"]),
    );
  });

  it("terminal-events list is a proper subset of bus-events, limited to the 3 streams should auto-close on", () => {
    expect(STREAMLINE_TERMINAL_EVENTS).toEqual([
      "workflow:completed",
      "workflow:failed",
      "workflow:cancelled",
    ]);
    for (const terminal of STREAMLINE_TERMINAL_EVENTS) {
      expect(STREAMLINE_BUS_EVENTS).toContain(terminal);
    }
    // Not terminal but commonly mistaken: recovered / resumed / waiting / retry / compensating
    expect(STREAMLINE_TERMINAL_EVENTS).not.toContain("workflow:recovered" as never);
    expect(STREAMLINE_TERMINAL_EVENTS).not.toContain("workflow:waiting" as never);
    expect(STREAMLINE_TERMINAL_EVENTS).not.toContain("workflow:resumed" as never);
  });
});

// ============================================================================
// Bus-event bridging
// ============================================================================

describe("v2.11.0 — `bridgeBusEvents` bridges all streamline 2.2 events to arc's bus", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  async function setupApp(wf: WorkflowLike, opts: Record<string, unknown> = {}) {
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
      ...opts,
    });
    await app.ready();
    return published;
  }

  it("bridges every event in STREAMLINE_BUS_EVENTS to topic `workflow.${id}.${event}`", async () => {
    const wf = createMockWorkflow("full-bridge");
    const innerBus = (wf as WorkflowLike & { _innerBus: EventEmitter })._innerBus;
    const published = await setupApp(wf);

    // Emit one of each event name
    for (const event of STREAMLINE_BUS_EVENTS) {
      innerBus.emit(event, { runId: "run-1", stepId: "s1" });
    }
    await new Promise((r) => setTimeout(r, 50));

    for (const event of STREAMLINE_BUS_EVENTS) {
      const topic = `workflow.full-bridge.${event}`;
      expect(published.some((p) => p.type === topic)).toBe(true);
    }
  });

  it("preserves payload runId/stepId + adds workflowId", async () => {
    const wf = createMockWorkflow("payload-test");
    const innerBus = (wf as WorkflowLike & { _innerBus: EventEmitter })._innerBus;
    const published = await setupApp(wf);

    innerBus.emit("step:completed", { runId: "r-x", stepId: "s-y", data: { foo: "bar" } });
    await new Promise((r) => setTimeout(r, 50));

    const match = published.find((p) => p.type === "workflow.payload-test.step:completed");
    expect(match).toBeDefined();
    const payload = match?.payload as {
      runId: string;
      stepId: string;
      workflowId: string;
      data: unknown;
    };
    expect(payload.runId).toBe("r-x");
    expect(payload.stepId).toBe("s-y");
    expect(payload.workflowId).toBe("payload-test");
    expect(payload.data).toEqual({ foo: "bar" });
  });

  it("engine-level events (no runId) are bridged — telemetry without run scope works", async () => {
    const wf = createMockWorkflow("engine-events");
    const innerBus = (wf as WorkflowLike & { _innerBus: EventEmitter })._innerBus;
    const published = await setupApp(wf);

    innerBus.emit("engine:error", { error: new Error("boom"), context: "worker-loop" });
    innerBus.emit("scheduler:circuit-open", { error: new Error("bleed"), context: "db" });
    await new Promise((r) => setTimeout(r, 50));

    expect(published.some((p) => p.type === "workflow.engine-events.engine:error")).toBe(true);
    expect(published.some((p) => p.type === "workflow.engine-events.scheduler:circuit-open")).toBe(
      true,
    );
  });

  it("events NOT in STREAMLINE_BUS_EVENTS are ignored (forward-compat — unknown events don't crash)", async () => {
    // Emulates a future streamline release emitting an event arc doesn't
    // know about yet. Arc's structural subscription is a no-op for it.
    const wf = createMockWorkflow("future-events");
    const innerBus = (wf as WorkflowLike & { _innerBus: EventEmitter })._innerBus;
    const published = await setupApp(wf);

    innerBus.emit("step:started", { runId: "r1" }); // known
    innerBus.emit("step:hypothetical-future-event-2028", { runId: "r1" }); // unknown
    await new Promise((r) => setTimeout(r, 50));

    expect(published.some((p) => p.type === "workflow.future-events.step:started")).toBe(true);
    expect(published.some((p) => p.type.includes("hypothetical-future-event"))).toBe(false);
  });

  it("bridgeBusEvents is off by default (opt-in)", async () => {
    const wf = createMockWorkflow("off-default");
    const innerBus = (wf as WorkflowLike & { _innerBus: EventEmitter })._innerBus;

    const published: unknown[] = [];
    app = Fastify({ logger: false });
    app.decorate("events", {
      publish: vi.fn(async (_t: string, p: unknown) => published.push(p)),
    });
    await app.register(streamlinePlugin, { workflows: [wf], auth: false });
    await app.ready();

    innerBus.emit("step:completed", { runId: "r1", stepId: "s1" });
    await new Promise((r) => setTimeout(r, 50));

    expect(published).toHaveLength(0);
  });
});

// 2.13 — `bridgeStepEvents` deprecated alias REMOVED. Hosts must use the
// canonical `bridgeBusEvents`. The two test blocks that pinned the alias
// behaviour were deleted alongside.
