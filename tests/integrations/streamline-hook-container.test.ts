/**
 * `POST /hooks/:token` hands streamline's `resumeHook` the container the run lives in.
 * Without it the DB-fallback resume writes through the DEFAULT connection's repository and
 * strict-concurrency counter — wrong for a streamline bound to another connection.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const resumeHook = vi.hoisted(() => vi.fn());

vi.mock("@classytic/streamline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@classytic/streamline")>()),
  resumeHook,
}));

import {
  streamlinePlugin,
  type WorkflowLike,
  type WorkflowRunLike,
} from "../../src/integrations/streamline.js";

const runDoc: WorkflowRunLike = { _id: "run-1", workflowId: "wf", status: "running" };

function container(holdsRun: boolean): NonNullable<WorkflowLike["container"]> {
  return {
    eventBus: { on: () => undefined, off: () => undefined },
    repository: {
      getAll: async () => ({}),
      getById: async (id) => (holdsRun && id === "run-1" ? runDoc : null),
    },
  };
}

function workflow(id: string, c: WorkflowLike["container"]): WorkflowLike {
  const start = async () => runDoc;
  return {
    definition: { id, steps: {} },
    engine: { start, execute: start, resume: start, cancel: start, get: async () => null },
    start,
    resume: start,
    cancel: start,
    get: async () => null,
    ...(c ? { container: c } : {}),
  };
}

let app: FastifyInstance;

async function boot(workflows: WorkflowLike[]) {
  app = Fastify({ logger: false });
  await app.register(streamlinePlugin, { workflows, auth: false, enableHookEndpoint: true });
  await app.ready();
}

afterEach(async () => {
  resumeHook.mockReset();
  await app?.close();
});

describe("POST /hooks/:token — container", () => {
  it("passes the sole container", async () => {
    resumeHook.mockResolvedValue({ runId: "run-1", run: runDoc });
    const c = container(true);
    await boot([workflow("a", c), workflow("b", c)]);

    const res = await app.inject({
      method: "POST",
      url: "/workflows/hooks/run-1:abc",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(resumeHook).toHaveBeenCalledWith("run-1:abc", {}, { container: c });
  });

  it("with several containers, passes the one that holds the run", async () => {
    resumeHook.mockResolvedValue({ runId: "run-1", run: runDoc });
    const other = container(false);
    const owner = container(true);
    await boot([workflow("a", other), workflow("b", owner)]);

    await app.inject({ method: "POST", url: "/workflows/hooks/run-1:abc", payload: {} });

    expect(resumeHook).toHaveBeenCalledWith("run-1:abc", {}, { container: owner });
  });

  it("passes no container when the workflows expose none", async () => {
    resumeHook.mockResolvedValue({ runId: "run-1", run: runDoc });
    await boot([workflow("a", undefined)]);

    await app.inject({ method: "POST", url: "/workflows/hooks/run-1:abc", payload: {} });

    expect(resumeHook).toHaveBeenCalledWith("run-1:abc", {}, undefined);
  });
});
