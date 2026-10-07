/**
 * Arc's streamline vocabulary, pinned against streamline's OWN.
 *
 * Arc keeps hand-written copies of streamline's event names and terminal run
 * statuses (structural coupling — the integration never imports streamline at
 * module level). Streamline already derives both from one exhaustive registry
 * and exports them; arc's copies drifted anyway:
 *
 *   - the saga outcomes `workflow:compensated` / `workflow:compensation_failed`
 *     are emitted under a COMPUTED name, so a grep for literal emits never
 *     found them — they never reached arc's bus, and a stream on a rolled-back
 *     run never saw it end;
 *   - `TERMINAL_RUN_STATUSES` lacked `compensated` / `compensation_failed`, so
 *     a stream on an already rolled-back run was held open until the client
 *     gave up;
 *   - `workflow:failed` closed every stream, including a saga's — the very
 *     moment BEFORE the rollback the client most needs to watch.
 *
 * The first two are pinned below against the installed streamline, so the next
 * event it adds fails here instead of going missing in production.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import {
  ALL_WORKFLOW_EVENT_NAMES,
  TERMINAL_RUN_STATUSES as STREAMLINE_TERMINAL_STATUSES,
} from "@classytic/streamline";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isStreamTerminal,
  STREAMLINE_BUS_EVENTS,
  STREAMLINE_STREAM_EVENTS,
  STREAMLINE_TERMINAL_EVENTS,
  streamlinePlugin,
  TERMINAL_RUN_STATUSES,
  type WorkflowLike,
  type WorkflowRunLike,
} from "../../src/integrations/streamline.js";

describe("arc's lists match streamline's exported source of truth", () => {
  const arcSubscribed = new Set<string>([...STREAMLINE_BUS_EVENTS, ...STREAMLINE_STREAM_EVENTS]);

  it("arc subscribes to EVERY event streamline can emit", () => {
    const missing = ALL_WORKFLOW_EVENT_NAMES.filter((e) => !arcSubscribed.has(e));
    // A name here is an event streamline emits that arc never bridges or
    // streams. Add it to STREAMLINE_BUS_EVENTS (or STREAM_EVENTS for
    // high-frequency, non-durable frames).
    expect(missing).toEqual([]);
  });

  it("arc lists no event streamline does not emit (a typo is a silent no-op)", () => {
    const known = new Set<string>(ALL_WORKFLOW_EVENT_NAMES);
    expect([...arcSubscribed].filter((e) => !known.has(e))).toEqual([]);
  });

  it("terminal run statuses are exactly streamline's", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual([...STREAMLINE_TERMINAL_STATUSES].sort());
  });

  it("every terminal event is one arc actually subscribes to", () => {
    for (const e of STREAMLINE_TERMINAL_EVENTS) expect(arcSubscribed.has(e)).toBe(true);
  });
});

describe("isStreamTerminal — failed ends a run only when nothing will compensate it", () => {
  it.each([
    ["event", "workflow:completed", false, true],
    ["event", "workflow:cancelled", false, true],
    ["event", "workflow:compensated", true, true],
    ["event", "workflow:compensation_failed", true, true],
    ["event", "workflow:failed", false, true],
    ["event", "workflow:failed", true, false], // saga: the rollback is still coming
    ["event", "workflow:compensating", true, false],
    ["event", "workflow:paused", false, false],
    ["status", "done", false, true],
    ["status", "compensated", true, true],
    ["status", "compensation_failed", true, true],
    ["status", "failed", false, true],
    ["status", "failed", true, false],
    ["status", "compensating", true, false],
    ["status", "running", false, false],
  ] as const)("%s %s (compensates=%s) → %s", (kind, name, compensates, expected) => {
    expect(isStreamTerminal(name, compensates, kind)).toBe(expected);
  });
});

// ============================================================================
// End to end through the SSE route
// ============================================================================

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function workflow(opts: { compensates: boolean; status?: string }) {
  const bus = new EventEmitter();
  const run: WorkflowRunLike = {
    _id: "run-1",
    workflowId: "order",
    status: opts.status ?? "running",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const get = vi.fn(async (id: string) => (id === run._id ? run : null));
  const wf: WorkflowLike = {
    definition: { id: "order", name: "order", steps: {} },
    engine: {
      start: vi.fn(async () => run),
      execute: vi.fn(async () => run),
      resume: vi.fn(async () => run),
      cancel: vi.fn(async () => run),
      get,
      ...(opts.compensates
        ? { options: { compensationHandlers: { reserveStock: async () => {} } } }
        : {}),
    },
    start: vi.fn(async () => run),
    resume: vi.fn(async () => run),
    cancel: vi.fn(async () => run),
    get,
    container: {
      eventBus: {
        on: (e: string, l: (...a: unknown[]) => void) => void bus.on(e, l),
        off: (e: string, l: (...a: unknown[]) => void) => void bus.off(e, l),
      },
    },
  };
  return { wf, bus };
}

/** Open the stream; resolves with the body and whether the SERVER ended it. */
async function openStream(
  wf: WorkflowLike,
): Promise<{ done: Promise<{ body: string; serverEnded: boolean }> }> {
  app = Fastify({ logger: false });
  await app.register(streamlinePlugin, { workflows: [wf], auth: false, enableStreaming: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as { port: number };
  let connected: () => void = () => {};
  const ready = new Promise<void>((r) => (connected = r));
  const done = new Promise<{ body: string; serverEnded: boolean }>((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/workflows/order/runs/run-1/stream`, (res) => {
      let body = "";
      connected();
      const timer = setTimeout(() => {
        res.destroy();
        resolve({ body, serverEnded: false });
      }, 400);
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ body, serverEnded: true });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
  await ready;
  await new Promise((r) => setTimeout(r, 30));
  return { done };
}

describe("SSE stream on a saga run", () => {
  it("stays OPEN through workflow:failed and closes on workflow:compensated", async () => {
    const { wf, bus } = workflow({ compensates: true });
    const { done } = await openStream(wf);

    bus.emit("workflow:failed", { runId: "run-1" });
    bus.emit("workflow:compensating", { runId: "run-1" });
    bus.emit("workflow:compensated", { runId: "run-1" });

    const { body, serverEnded } = await done;
    // The client sees the whole rollback, then the server ends the stream.
    expect(body).toContain("event: workflow:failed");
    expect(body).toContain("event: workflow:compensating");
    expect(body).toContain("event: workflow:compensated");
    expect(serverEnded).toBe(true);
  });

  it("closes on workflow:compensation_failed — the outcome ops most needs to see", async () => {
    const { wf, bus } = workflow({ compensates: true });
    const { done } = await openStream(wf);
    bus.emit("workflow:failed", { runId: "run-1" });
    bus.emit("workflow:compensation_failed", { runId: "run-1" });
    const { body, serverEnded } = await done;
    expect(body).toContain("event: workflow:compensation_failed");
    expect(serverEnded).toBe(true);
  });

  it("a workflow WITHOUT compensation still closes on workflow:failed", async () => {
    const { wf, bus } = workflow({ compensates: false });
    const { done } = await openStream(wf);
    bus.emit("workflow:failed", { runId: "run-1" });
    const { serverEnded } = await done;
    expect(serverEnded).toBe(true);
  });

  it("a run ALREADY compensated at connect gets its snapshot and an immediate close", async () => {
    const { wf } = workflow({ compensates: true, status: "compensated" });
    const { done } = await openStream(wf);
    const { body, serverEnded } = await done;
    expect(body).toContain("event: workflow:snapshot");
    expect(serverEnded).toBe(true);
  });
});
