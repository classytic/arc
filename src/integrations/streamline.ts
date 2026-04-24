/**
 * @classytic/arc — Streamline Integration
 *
 * Pluggable adapter that wires @classytic/streamline workflows into Arc's
 * Fastify application. Provides REST endpoints for workflow management,
 * auto-connects to Arc's event bus, and respects Arc's auth/permissions.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
 *
 * Requires: @classytic/streamline (peer dependency, >= 2.2.0)
 *
 * @example
 * ```typescript
 * import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
 * import { orderWorkflow } from './workflows/order.js';
 *
 * await fastify.register(streamlinePlugin, {
 *   workflows: [orderWorkflow],
 *   prefix: '/api/workflows',
 *   auth: true, // require authentication for workflow endpoints
 * });
 *
 * // Starts the workflow
 * // POST /api/workflows/order/start { input }
 * // GET  /api/workflows/order/runs/:runId
 * // POST /api/workflows/order/runs/:runId/resume { payload }
 * // POST /api/workflows/order/runs/:runId/cancel
 * // GET  /api/workflows/order/runs (list runs)
 * ```
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

// ============================================================================
// Types (defined here so we don't import streamline at module level)
// ============================================================================

/** Start options — matches @classytic/streamline v2.1+ StartOptions */
export interface WorkflowStartOptions {
  meta?: Record<string, unknown>;
  idempotencyKey?: string;
  priority?: number;
}

/** Minimal workflow interface — matches @classytic/streamline's createWorkflow() return */
export interface WorkflowLike {
  definition: { id: string; name?: string; steps: Record<string, unknown> | unknown[] };
  engine: {
    start(input: unknown, options?: WorkflowStartOptions): Promise<WorkflowRunLike>;
    execute(runId: string): Promise<WorkflowRunLike>;
    resume(runId: string, payload?: unknown): Promise<WorkflowRunLike>;
    cancel(runId: string): Promise<WorkflowRunLike>;
    pause?(runId: string): Promise<WorkflowRunLike>;
    rewindTo?(runId: string, stepId: string): Promise<WorkflowRunLike>;
    get(runId: string): Promise<WorkflowRunLike | null>;
    waitFor?(runId: string, options?: { timeout?: number }): Promise<WorkflowRunLike>;
    shutdown?(): void;
  };
  start(input: unknown, options?: WorkflowStartOptions): Promise<WorkflowRunLike>;
  resume(runId: string, payload?: unknown): Promise<WorkflowRunLike>;
  cancel(runId: string): Promise<WorkflowRunLike>;
  get(runId: string): Promise<WorkflowRunLike | null>;
  shutdown?(): void;
  /** Streamline container for event bridging (streamline >=2.1) */
  container?: {
    eventBus: {
      on(event: string, listener: (...args: unknown[]) => void): void;
      off(event: string, listener: (...args: unknown[]) => void): void;
    };
  };
}

export interface WorkflowRunLike {
  _id: string;
  workflowId: string;
  status: string;
  context?: unknown;
  input?: unknown;
  steps?: unknown[];
  error?: unknown;
  idempotencyKey?: string;
  priority?: number;
  concurrencyKey?: string;
  stepLogs?: unknown[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface StreamlinePluginOptions {
  /** Array of workflows created with createWorkflow() */
  workflows: WorkflowLike[];
  /** URL prefix for workflow endpoints (default: '/workflows') */
  prefix?: string;
  /** Require authentication for all workflow endpoints (default: true) */
  auth?: boolean;
  /** Connect workflow lifecycle events to Arc's event bus (default: true) */
  bridgeEvents?: boolean;
  /**
   * Bridge the workflow's internal event bus (step + workflow lifecycle +
   * engine telemetry) to Arc's event bus, topic-scoped as
   * `workflow.${workflowId}.${eventName}`.
   *
   * Covers the full streamline 2.2 event surface:
   *   - Step events: started, completed, failed, waiting, skipped,
   *     retry-scheduled, compensated
   *   - Workflow lifecycle: started, completed, failed, waiting, resumed,
   *     cancelled, recovered, retry, compensating
   *   - Engine telemetry: engine:error, scheduler:error,
   *     scheduler:circuit-open
   *
   * Subscriptions use structural `container.eventBus.on(...)` — future
   * streamline releases can add events without breaking arc; missing
   * events are simply never handled (no crash). Requires the workflow
   * to expose `container.eventBus`.
   *
   * Disabled by default — enable for dashboards or monitoring.
   * @default false
   */
  bridgeBusEvents?: boolean;
  /**
   * @deprecated v2.11.0 — renamed to `bridgeBusEvents` which now covers
   * step + workflow + engine events (not just step-level). Still accepted
   * as an alias; will be removed in v3. Prefer `bridgeBusEvents`.
   */
  bridgeStepEvents?: boolean;
  /**
   * Enable SSE streaming endpoint: GET /:workflowId/runs/:runId/stream
   * Streams step-level + lifecycle events as Server-Sent Events for live
   * UI updates. Auto-closes the stream on terminal workflow events
   * (completed / failed / cancelled).
   * @default false
   */
  enableStreaming?: boolean;
  /** Custom permission check for workflow operations */
  permissions?: {
    start?: (request: unknown) => boolean | Promise<boolean>;
    resume?: (request: unknown) => boolean | Promise<boolean>;
    cancel?: (request: unknown) => boolean | Promise<boolean>;
    list?: (request: unknown) => boolean | Promise<boolean>;
    get?: (request: unknown) => boolean | Promise<boolean>;
  };
}

// ============================================================================
// Streamline event names — raw names on `container.eventBus`
// ============================================================================

/**
 * Full event list published on a streamline workflow's internal `eventBus`
 * (tracks streamline 2.2's `EventPayloadMap` in
 * `@classytic/streamline/src/core/events.ts`).
 *
 * Hardcoded here by design — arc subscribes via structural
 * `eventBus.on(name, handler)`, which is a no-op for events the running
 * streamline version doesn't emit. New events a future streamline release
 * adds can be bridged by updating this list; arc never breaks just
 * because streamline extended its bus.
 */
export const STREAMLINE_BUS_EVENTS = [
  // Step lifecycle
  "step:started",
  "step:completed",
  "step:failed",
  "step:waiting",
  "step:skipped",
  "step:retry-scheduled",
  "step:compensated",
  // Workflow lifecycle
  "workflow:started",
  "workflow:completed",
  "workflow:failed",
  "workflow:waiting",
  "workflow:resumed",
  "workflow:cancelled",
  "workflow:recovered",
  "workflow:retry",
  "workflow:compensating",
  // Engine telemetry
  "engine:error",
  "scheduler:error",
  "scheduler:circuit-open",
] as const;

/**
 * Workflow events that should auto-close an SSE stream when observed.
 * Recovered / waiting / resumed / retry / compensating are NOT terminal —
 * the run is still active after them.
 */
export const STREAMLINE_TERMINAL_EVENTS = [
  "workflow:completed",
  "workflow:failed",
  "workflow:cancelled",
] as const;

// ============================================================================
// Plugin Implementation
// ============================================================================

const streamlinePluginImpl: FastifyPluginAsync<StreamlinePluginOptions> = async (
  fastify: FastifyInstance,
  options: StreamlinePluginOptions,
) => {
  const {
    workflows,
    prefix = "/workflows",
    auth = true,
    bridgeEvents = true,
    enableStreaming = false,
    permissions: perms,
  } = options;

  // Canonical name `bridgeBusEvents`; legacy `bridgeStepEvents` kept as
  // alias for back-compat (deprecated — removed in v3). OR semantics:
  // either flag enables full bus bridging.
  const bridgeBus = options.bridgeBusEvents ?? options.bridgeStepEvents ?? false;

  // Registry: workflowId → workflow instance
  const registry = new Map<string, WorkflowLike>();

  for (const wf of workflows) {
    const id = wf.definition.id;
    if (registry.has(id)) {
      throw new Error(`Duplicate workflow ID: '${id}'`);
    }
    registry.set(id, wf);
  }

  // Decorate fastify with workflow accessor
  if (!fastify.hasDecorator("workflows")) {
    fastify.decorate("workflows", registry);
  }
  if (!fastify.hasDecorator("getWorkflow")) {
    fastify.decorate("getWorkflow", (id: string) => registry.get(id) ?? null);
  }

  // Build auth preHandler if needed
  const authPreHandler =
    auth && typeof fastify.authenticate === "function" ? [fastify.authenticate] : [];

  // Permission check helper
  const checkPerm = async (
    op: keyof NonNullable<StreamlinePluginOptions["permissions"]>,
    request: unknown,
  ): Promise<boolean> => {
    const check = perms?.[op];
    if (!check) return true;
    return check(request);
  };

  // Register routes per workflow
  for (const [id, wf] of registry) {
    const routePrefix = `${prefix}/${id}`;

    // POST /:workflowId/start — Start a new workflow run
    fastify.post(
      `${routePrefix}/start`,
      {
        preHandler: authPreHandler,
      },
      async (request, reply) => {
        if (!(await checkPerm("start", request))) {
          return reply.status(403).send({ success: false, error: "Forbidden" });
        }
        const { input, meta, idempotencyKey, priority } = (request.body ?? {}) as {
          input?: unknown;
          meta?: Record<string, unknown>;
          idempotencyKey?: string;
          priority?: number;
        };
        const run = await wf.start(input, { meta, idempotencyKey, priority });

        // Bridge event to Arc's event bus (fire-and-forget — never fail the HTTP response)
        if (bridgeEvents && fastify.events?.publish) {
          try {
            await fastify.events.publish(`workflow.${id}.started`, {
              runId: run._id,
              workflowId: id,
              status: run.status,
            });
          } catch (err) {
            fastify.log.warn({ err, workflowId: id }, "Failed to publish workflow.started event");
          }
        }

        return reply.status(201).send({ success: true, data: run });
      },
    );

    // GET /:workflowId/runs/:runId — Get a workflow run
    fastify.get(
      `${routePrefix}/runs/:runId`,
      {
        preHandler: authPreHandler,
      },
      async (request, reply) => {
        if (!(await checkPerm("get", request))) {
          return reply.status(403).send({ success: false, error: "Forbidden" });
        }
        const { runId } = request.params as { runId: string };
        const run = await wf.get(runId);
        if (!run) {
          return reply.status(404).send({ success: false, error: "Workflow run not found" });
        }
        return { success: true, data: run };
      },
    );

    // POST /:workflowId/runs/:runId/resume — Resume a waiting workflow
    fastify.post(
      `${routePrefix}/runs/:runId/resume`,
      {
        preHandler: authPreHandler,
      },
      async (request, reply) => {
        if (!(await checkPerm("resume", request))) {
          return reply.status(403).send({ success: false, error: "Forbidden" });
        }
        const { runId } = request.params as { runId: string };
        const { payload } = (request.body ?? {}) as { payload?: unknown };
        const run = await wf.resume(runId, payload);

        if (bridgeEvents && fastify.events?.publish) {
          try {
            await fastify.events.publish(`workflow.${id}.resumed`, {
              runId: run._id,
              workflowId: id,
              status: run.status,
            });
          } catch (err) {
            fastify.log.warn({ err, workflowId: id }, "Failed to publish workflow.resumed event");
          }
        }

        return { success: true, data: run };
      },
    );

    // POST /:workflowId/runs/:runId/cancel — Cancel a workflow run
    fastify.post(
      `${routePrefix}/runs/:runId/cancel`,
      {
        preHandler: authPreHandler,
      },
      async (request, reply) => {
        if (!(await checkPerm("cancel", request))) {
          return reply.status(403).send({ success: false, error: "Forbidden" });
        }
        const { runId } = request.params as { runId: string };
        const run = await wf.cancel(runId);

        if (bridgeEvents && fastify.events?.publish) {
          try {
            await fastify.events.publish(`workflow.${id}.cancelled`, {
              runId: run._id,
              workflowId: id,
            });
          } catch (err) {
            fastify.log.warn({ err, workflowId: id }, "Failed to publish workflow.cancelled event");
          }
        }

        return { success: true, data: run };
      },
    );

    // POST /:workflowId/runs/:runId/execute — Execute (resume from start) a workflow run
    fastify.post(
      `${routePrefix}/runs/:runId/execute`,
      {
        preHandler: authPreHandler,
      },
      async (request, _reply) => {
        const { runId } = request.params as { runId: string };
        const run = await wf.engine.execute(runId);
        return { success: true, data: run };
      },
    );

    // GET /:workflowId/runs/:runId/wait — Poll until workflow reaches terminal state (if supported)
    if (wf.engine.waitFor) {
      fastify.get(
        `${routePrefix}/runs/:runId/wait`,
        {
          preHandler: authPreHandler,
        },
        async (request, reply) => {
          if (!(await checkPerm("get", request))) {
            return reply.status(403).send({ success: false, error: "Forbidden" });
          }
          const { runId } = request.params as { runId: string };
          const { timeout } = (request.query ?? {}) as { timeout?: string };
          const timeoutMs = timeout ? Number.parseInt(timeout, 10) : 30000;
          const run = await wf.engine.waitFor!(runId, {
            timeout: Math.min(timeoutMs, 120000),
          });
          return { success: true, data: run };
        },
      );
    }

    // POST /:workflowId/runs/:runId/pause — Pause a running workflow (if supported)
    if (wf.engine.pause) {
      fastify.post(
        `${routePrefix}/runs/:runId/pause`,
        {
          preHandler: authPreHandler,
        },
        async (request, _reply) => {
          const { runId } = request.params as { runId: string };
          const run = await wf.engine.pause?.(runId);
          return { success: true, data: run };
        },
      );
    }

    // POST /:workflowId/runs/:runId/rewind — Rewind to a step (if supported)
    if (wf.engine.rewindTo) {
      fastify.post(
        `${routePrefix}/runs/:runId/rewind`,
        {
          preHandler: authPreHandler,
        },
        async (request, reply) => {
          const { runId } = request.params as { runId: string };
          const { stepId } = (request.body ?? {}) as { stepId: string };
          if (!stepId) {
            return reply.status(400).send({ success: false, error: "stepId is required" });
          }
          const run = await wf.engine.rewindTo?.(runId, stepId);
          return { success: true, data: run };
        },
      );
    }

    // ============ Opt-in: workflow event-bus bridging ============
    //
    // Full coverage of streamline 2.2's internal event bus (step +
    // workflow lifecycle + engine telemetry), published onto arc's
    // transport as `workflow.${id}.${eventName}`. Subscriptions are
    // structural — arc never crashes if streamline drops an event in a
    // future release, and new events are picked up by updating
    // `STREAMLINE_BUS_EVENTS` without touching plugin internals.
    if (bridgeBus && wf.container?.eventBus && fastify.events?.publish) {
      for (const eventName of STREAMLINE_BUS_EVENTS) {
        wf.container.eventBus.on(eventName, (payload: unknown) => {
          const p = payload as {
            runId?: string;
            stepId?: string;
            [k: string]: unknown;
          };
          fastify.events
            .publish(`workflow.${id}.${eventName}`, {
              runId: p?.runId,
              stepId: p?.stepId,
              workflowId: id,
              ...p,
            })
            .catch((err: unknown) => {
              fastify.log.warn({ err, workflowId: id }, `Failed to bridge ${eventName}`);
            });
        });
      }
    }

    // ============ Opt-in: SSE streaming endpoint ============
    if (enableStreaming && wf.container?.eventBus) {
      fastify.get(
        `${routePrefix}/runs/:runId/stream`,
        { preHandler: authPreHandler },
        async (request, reply) => {
          if (!(await checkPerm("get", request))) {
            return reply.status(403).send({ success: false, error: "Forbidden" });
          }

          const { runId } = request.params as { runId: string };
          const run = await wf.get(runId);
          if (!run) {
            return reply.status(404).send({ success: false, error: "Workflow run not found" });
          }

          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          // Stream every streamline bus event — run-scoped filter applied
          // per-event. Terminal events auto-close the stream.
          const terminalEvents = new Set<string>(STREAMLINE_TERMINAL_EVENTS);
          const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
          let closed = false;

          const send = (event: string, data: unknown) => {
            if (closed) return;
            try {
              reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch {
              // Client disconnected
              cleanup();
            }
          };

          const cleanup = () => {
            if (closed) return;
            closed = true;
            for (const { event, fn } of listeners) {
              wf.container?.eventBus.off(event, fn);
            }
            listeners.length = 0;
            try {
              reply.raw.end();
            } catch {
              // Already ended
            }
          };

          for (const eventName of STREAMLINE_BUS_EVENTS) {
            const fn = (payload: unknown) => {
              const p = payload as { runId?: string; [k: string]: unknown };
              // Engine telemetry events (engine:error, scheduler:*) can
              // fire without a runId — deliver them on every stream for
              // the workflow (they're observability, not run-scoped).
              const isRunEvent = typeof p?.runId === "string";
              if (isRunEvent && p.runId !== runId) return;
              send(eventName, p);

              if (terminalEvents.has(eventName) && p?.runId === runId) {
                cleanup();
              }
            };
            wf.container!.eventBus.on(eventName, fn);
            listeners.push({ event: eventName, fn });
          }

          // Clean up on client disconnect
          request.raw.on("close", cleanup);
        },
      );
    }
  }

  // List all registered workflows
  fastify.get(
    prefix,
    {
      preHandler: authPreHandler,
    },
    async () => {
      const list = Array.from(registry.entries()).map(([id, wf]) => ({
        id,
        name: wf.definition.name ?? id,
        steps: Array.isArray(wf.definition.steps)
          ? wf.definition.steps.map((s: unknown) => (s as { id?: string }).id ?? String(s))
          : Object.keys(wf.definition.steps),
      }));
      return { success: true, data: list };
    },
  );

  // Graceful shutdown
  fastify.addHook("onClose", async () => {
    for (const wf of registry.values()) {
      wf.shutdown?.();
    }
  });
};

/** Pluggable streamline integration for Arc */
export const streamlinePlugin: FastifyPluginAsync<StreamlinePluginOptions> = streamlinePluginImpl;
