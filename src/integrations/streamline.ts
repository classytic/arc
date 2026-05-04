/**
 * @classytic/arc — Streamline Integration
 *
 * Pluggable adapter that wires @classytic/streamline workflows into Arc's
 * Fastify application. Provides REST endpoints for workflow management,
 * auto-connects to Arc's event bus, respects Arc's auth/permissions, and
 * surfaces streamline's repo-core-aligned `HttpError`s with the correct
 * HTTP status codes (no generic-500-on-everything).
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
 *
 * Requires: @classytic/streamline (peer dependency, >= 2.3.0) — uses the
 * v2.3 surface: `StartOptions.tenantId/bypassTenant`,
 * `WorkflowError implements HttpError`, `resumeHook` fail-closed
 * validation, strict-concurrency `ConcurrencyLimitReachedError` (status 429).
 *
 * @example
 * ```typescript
 * import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
 * import { orderWorkflow } from './workflows/order.js';
 *
 * await fastify.register(streamlinePlugin, {
 *   workflows: [orderWorkflow],
 *   prefix: '/api/workflows',
 *   auth: true,
 *   // Multi-tenant: extract tenantId from auth context per request.
 *   tenantResolver: (req) => req.user?.organizationId,
 *   // Opt-in: webhook resume endpoint with token-validated resumeHook.
 *   enableHookEndpoint: true,
 * });
 *
 * // POST /api/workflows/order/start { input }
 * // GET  /api/workflows/order/runs (list)
 * // GET  /api/workflows/order/runs/:runId
 * // POST /api/workflows/order/runs/:runId/resume { payload }
 * // POST /api/workflows/order/runs/:runId/cancel
 * // POST /api/workflows/hooks/:token { ... } (when enableHookEndpoint)
 * ```
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { createError, ForbiddenError, NotFoundError } from "../utils/errors.js";

// ============================================================================
// Types (defined here so we don't import streamline at module level — keeps
// the subpath cheap to import even when streamline isn't installed)
// ============================================================================

/**
 * Start options — matches @classytic/streamline v2.3+ `StartOptions`.
 *
 * v2.3 additions:
 *   - `tenantId` — required when streamline's `multiTenant.strict: true`.
 *     Hosts should NOT accept this from the request body in untrusted
 *     contexts; use `tenantResolver` to extract from auth context instead.
 *   - `bypassTenant` — admin/cross-tenant operations. Same caveat.
 */
export interface WorkflowStartOptions {
  meta?: Record<string, unknown>;
  idempotencyKey?: string;
  priority?: number;
  tenantId?: string;
  bypassTenant?: boolean;
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
  /** Streamline container for event bridging + repository access (streamline >=2.1) */
  container?: {
    eventBus: {
      on(event: string, listener: (...args: unknown[]) => void): void;
      off(event: string, listener: (...args: unknown[]) => void): void;
    };
    /** Repository — used by the list-runs endpoint to query workflow_runs. */
    repository?: {
      getAll(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
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
   * Covers the full streamline 2.3 event surface:
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
   * Enable SSE streaming endpoint: GET /:workflowId/runs/:runId/stream
   * Streams step-level + lifecycle events as Server-Sent Events for live
   * UI updates. Auto-closes the stream on terminal workflow events
   * (completed / failed / cancelled).
   * @default false
   */
  enableStreaming?: boolean;
  /**
   * Enable webhook resume endpoint: POST /hooks/:token
   *
   * Routes incoming webhook calls through streamline's `resumeHook(token,
   * body)` — which validates the token against the stored `hookToken` on
   * the waiting step (fail-closed since streamline 2.3). Hosts use this
   * for "wait for external approval / SaaS callback" patterns.
   *
   * Workflows MUST pass `{ hookToken: hook.token }` to `ctx.wait(...)` —
   * streamline 2.3 rejects resume otherwise (security). The endpoint is
   * registered at the plugin's `prefix` root, NOT scoped per workflow,
   * because the token encodes the runId.
   *
   * Auth is OPTIONAL on this route by design — the token IS the
   * authentication. If you also want to gate by user (e.g. only the
   * inviting user can approve), set `auth: true` and a permission check.
   *
   * @default false
   */
  enableHookEndpoint?: boolean;
  /**
   * Resolve the tenant id for a request — extract from auth context
   * (JWT claim, session, header), NOT from the request body. Returning
   * `undefined` skips tenant injection (use for non-multi-tenant routes
   * or admin paths that pass `bypassTenant` explicitly).
   *
   * When set, the resolved tenantId is forwarded to every streamline
   * call (`start`, `resume`, `cancel`, `get`, `list`, etc.) so
   * streamline's `multiTenant.strict` mode never throws "missing
   * tenantId" inside arc's request lifecycle.
   *
   * @example
   * tenantResolver: (req) => req.user?.organizationId
   */
  tenantResolver?: (request: FastifyRequest) => string | undefined;
  /**
   * Per-call bypass-tenant resolver. Returns `true` for requests that
   * should skip tenant scoping entirely (cross-tenant admin operations).
   * Honored only when streamline's tenant-filter plugin allows bypass
   * (`allowBypass: true`, the default).
   */
  bypassTenantResolver?: (request: FastifyRequest) => boolean;
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
 * (tracks streamline 2.3's `EventPayloadMap` in
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
    enableHookEndpoint = false,
    tenantResolver,
    bypassTenantResolver,
    permissions: perms,
  } = options;

  const bridgeBus = options.bridgeBusEvents ?? false;

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

  // ============ Tenant context resolution ============
  //
  // Resolve tenant id + bypass flag PER REQUEST from the auth context, NOT
  // from the request body. Forwarded to every streamline call so
  // multi-tenant strict mode never throws "missing tenantId" inside arc's
  // request lifecycle. When `tenantResolver` is unset the empty options
  // are passed through and streamline's static-tenant / single-tenant /
  // best-effort modes work unchanged.
  const resolveTenantOpts = (request: FastifyRequest): WorkflowStartOptions => {
    const opts: WorkflowStartOptions = {};
    if (bypassTenantResolver?.(request)) {
      opts.bypassTenant = true;
      return opts;
    }
    const tenantId = tenantResolver?.(request);
    if (tenantId !== undefined) opts.tenantId = tenantId;
    return opts;
  };

  // Permission check helper
  const checkPerm = async (
    op: keyof NonNullable<StreamlinePluginOptions["permissions"]>,
    request: unknown,
  ): Promise<boolean> => {
    const check = perms?.[op];
    if (!check) return true;
    return check(request);
  };

  // ============ Errors flow through arc's GLOBAL errorHandler ============
  //
  // No per-prefix `setErrorHandler` here — arc's global handler at
  // `src/plugins/errorHandler.ts` already detects HttpError-shaped throws
  // (via repo-core's `isHttpError`) and maps to the right status + reads
  // `error.code` (hierarchical) + `error.meta` (structured). Every
  // `WorkflowError` / `ConcurrencyLimitReachedError` (429) /
  // `WorkflowNotFoundError` (404) / `InvalidStateError` (400) flows
  // through that single canonical mapper. Adding a plugin-scoped handler
  // here would shadow the global one and ship two response shapes from
  // the same arc instance — exactly the seam-divergence the repo-core
  // contract exists to prevent.

  // Register routes per workflow
  for (const [id, wf] of registry) {
    const routePrefix = `${prefix}/${id}`;

    // POST /:workflowId/start — Start a new workflow run
    fastify.post(`${routePrefix}/start`, { preHandler: authPreHandler }, async (request, reply) => {
      if (!(await checkPerm("start", request))) {
        throw new ForbiddenError();
      }
      const { input, meta, idempotencyKey, priority } = (request.body ?? {}) as {
        input?: unknown;
        meta?: Record<string, unknown>;
        idempotencyKey?: string;
        priority?: number;
      };
      // Tenant context comes from auth, not from the request body —
      // never let a client dictate which tenant to scope a write to.
      const tenantOpts = resolveTenantOpts(request);
      const run = await wf.start(input, {
        meta,
        idempotencyKey,
        priority,
        ...tenantOpts,
      });

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

      return reply.status(201).send(run);
    });

    // GET /:workflowId/runs — List runs for this workflow (paginated)
    //
    // Documented in the plugin's docstring example but missing from the
    // pre-v2.3 implementation. Routes through
    // `wf.container.repository.getAll` so streamline's tenant-filter
    // plugin auto-scopes the read.
    // Capture the repository at registration time so the route handler
    // closure has a non-null reference (TS can't narrow `wf.container?.repository`
    // across the async closure boundary).
    const listRepo = wf.container?.repository;
    if (listRepo?.getAll) {
      fastify.get(
        `${routePrefix}/runs`,
        { preHandler: authPreHandler },
        async (request, _reply) => {
          if (!(await checkPerm("list", request))) {
            throw new ForbiddenError();
          }
          const tenantOpts = resolveTenantOpts(request);
          const {
            page = "1",
            limit = "20",
            cursor,
            status,
          } = (request.query ?? {}) as {
            page?: string;
            limit?: string;
            cursor?: string;
            status?: string;
          };
          const filters: Record<string, unknown> = { workflowId: id };
          if (status) filters.status = status;

          const result = await listRepo.getAll(
            {
              filters,
              sort: { createdAt: -1 },
              page: Number.parseInt(page, 10) || 1,
              limit: Math.min(Number.parseInt(limit, 10) || 20, 100),
              ...(cursor ? { cursor } : {}),
              ...(tenantOpts.tenantId !== undefined ? { tenantId: tenantOpts.tenantId } : {}),
            },
            {
              lean: true,
              ...(tenantOpts.bypassTenant ? { bypassTenant: true } : {}),
            },
          );
          return result;
        },
      );
    }

    // GET /:workflowId/runs/:runId — Get a workflow run
    fastify.get(
      `${routePrefix}/runs/:runId`,
      { preHandler: authPreHandler },
      async (request, _reply) => {
        if (!(await checkPerm("get", request))) {
          throw new ForbiddenError();
        }
        const { runId } = request.params as { runId: string };
        const run = await wf.get(runId);
        if (!run) {
          throw new NotFoundError("Workflow run", runId);
        }
        return run;
      },
    );

    // POST /:workflowId/runs/:runId/resume — Resume a waiting workflow
    //
    // NOTE: This is the engine.resume() path — no token validation. For
    // webhook-driven resume with token validation (streamline 2.3
    // fail-closed), use POST /:prefix/hooks/:token (enableHookEndpoint).
    fastify.post(
      `${routePrefix}/runs/:runId/resume`,
      { preHandler: authPreHandler },
      async (request, _reply) => {
        if (!(await checkPerm("resume", request))) {
          throw new ForbiddenError();
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

        return run;
      },
    );

    // POST /:workflowId/runs/:runId/cancel — Cancel a workflow run
    fastify.post(
      `${routePrefix}/runs/:runId/cancel`,
      { preHandler: authPreHandler },
      async (request, _reply) => {
        if (!(await checkPerm("cancel", request))) {
          throw new ForbiddenError();
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

        return run;
      },
    );

    // POST /:workflowId/runs/:runId/execute — Execute (resume from start) a workflow run
    fastify.post(
      `${routePrefix}/runs/:runId/execute`,
      { preHandler: authPreHandler },
      async (request, _reply) => {
        const { runId } = request.params as { runId: string };
        const run = await wf.engine.execute(runId);
        return run;
      },
    );

    // GET /:workflowId/runs/:runId/wait — Poll until workflow reaches terminal state (if supported)
    if (wf.engine.waitFor) {
      fastify.get(
        `${routePrefix}/runs/:runId/wait`,
        { preHandler: authPreHandler },
        async (request, _reply) => {
          if (!(await checkPerm("get", request))) {
            throw new ForbiddenError();
          }
          const { runId } = request.params as { runId: string };
          const { timeout } = (request.query ?? {}) as { timeout?: string };
          const timeoutMs = timeout ? Number.parseInt(timeout, 10) : 30000;
          const run = await wf.engine.waitFor?.(runId, {
            timeout: Math.min(timeoutMs, 120000),
          });
          return run;
        },
      );
    }

    // POST /:workflowId/runs/:runId/pause — Pause a running workflow (if supported)
    if (wf.engine.pause) {
      fastify.post(
        `${routePrefix}/runs/:runId/pause`,
        { preHandler: authPreHandler },
        async (request, _reply) => {
          const { runId } = request.params as { runId: string };
          const run = await wf.engine.pause?.(runId);
          return run;
        },
      );
    }

    // POST /:workflowId/runs/:runId/rewind — Rewind to a step (if supported)
    if (wf.engine.rewindTo) {
      fastify.post(
        `${routePrefix}/runs/:runId/rewind`,
        { preHandler: authPreHandler },
        async (request, _reply) => {
          const { runId } = request.params as { runId: string };
          const { stepId } = (request.body ?? {}) as { stepId: string };
          if (!stepId) {
            throw createError(400, "stepId is required");
          }
          const run = await wf.engine.rewindTo?.(runId, stepId);
          return run;
        },
      );
    }

    // ============ Opt-in: workflow event-bus bridging ============
    //
    // Full coverage of streamline 2.3's internal event bus (step +
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
            throw new ForbiddenError();
          }

          const { runId } = request.params as { runId: string };
          const run = await wf.get(runId);
          if (!run) {
            throw new NotFoundError("Workflow run", runId);
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
            wf.container?.eventBus.on(eventName, fn);
            listeners.push({ event: eventName, fn });
          }

          // Clean up on client disconnect
          request.raw.on("close", cleanup);
        },
      );
    }
  }

  // ============ Opt-in: webhook resume endpoint ============
  //
  // Routes incoming webhook calls through streamline's `resumeHook(token,
  // body)`, which validates the token against the stored `hookToken` on
  // the waiting step (fail-closed since streamline 2.3). Workflows MUST
  // pass `{ hookToken: hook.token }` to `ctx.wait(...)` — streamline 2.3
  // rejects resume otherwise (security fix; the README example used to
  // omit it).
  //
  // Auth is OPTIONAL — the token IS the authentication. Hosts wanting
  // user-level gating in addition can keep `auth: true` and a permission
  // check.
  //
  // Mounted at the plugin root (NOT per-workflow) because the token
  // encodes the runId; arc doesn't need to know which workflow the run
  // belongs to.
  if (enableHookEndpoint) {
    type ResumeHookFn = (
      token: string,
      payload: unknown,
    ) => Promise<{ runId: string; run: WorkflowRunLike }>;
    let resumeHookFn: ResumeHookFn | undefined;

    fastify.post(
      `${prefix}/hooks/:token`,
      { preHandler: authPreHandler },
      async (request, _reply) => {
        // Lazy import — keeps the streamline dep out of the module load
        // path when `enableHookEndpoint: false`. First request pays the
        // import cost; subsequent requests are cached.
        if (!resumeHookFn) {
          const streamline = (await import("@classytic/streamline")) as unknown as {
            resumeHook: ResumeHookFn;
          };
          resumeHookFn = streamline.resumeHook;
        }
        const { token } = request.params as { token: string };
        const result = await resumeHookFn(token, request.body);
        return { runId: result.runId, run: result.run };
      },
    );
  }

  // List all registered workflows
  fastify.get(prefix, { preHandler: authPreHandler }, async () => {
    const list = Array.from(registry.entries()).map(([id, wf]) => ({
      id,
      name: wf.definition.name ?? id,
      steps: Array.isArray(wf.definition.steps)
        ? wf.definition.steps.map((s: unknown) => (s as { id?: string }).id ?? String(s))
        : Object.keys(wf.definition.steps),
    }));
    return list;
  });

  // Graceful shutdown
  fastify.addHook("onClose", async () => {
    for (const wf of registry.values()) {
      wf.shutdown?.();
    }
  });
};

/** Pluggable streamline integration for Arc */
export const streamlinePlugin: FastifyPluginAsync<StreamlinePluginOptions> = streamlinePluginImpl;
