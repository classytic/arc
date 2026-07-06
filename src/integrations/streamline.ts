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
 * Requires: @classytic/streamline (peer dependency, >= 2.7.0) — uses the
 * v2.3 surface: `StartOptions.tenantId/bypassTenant`,
 * `WorkflowError implements HttpError`, `resumeHook` fail-closed
 * validation, strict-concurrency `ConcurrencyLimitReachedError` (status 429).
 * v2.7 additions surfaced here: `cancel(runId, { reason })` and
 * `pause(runId, { reason })` forward an operator reason (persisted on the
 * run + echoed in the `workflow:cancelled` / `workflow:paused` events), and
 * `workflow:paused` is bridged/streamed like every other lifecycle event.
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
import fp from "fastify-plugin";
import { createError, ForbiddenError, NotFoundError } from "../utils/errors.js";
import { forwardedStreamHeaders, promoteStreamTokenToHeader } from "../utils/streaming.js";

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
    // streamline >= 2.7: optional `{ reason }` persisted on the run + echoed
    // in the workflow:cancelled event. Optional arg — pre-2.7 engines ignore it.
    cancel(runId: string, options?: { reason?: string }): Promise<WorkflowRunLike>;
    pause?(runId: string, options?: { reason?: string }): Promise<WorkflowRunLike>;
    rewindTo?(runId: string, stepId: string): Promise<WorkflowRunLike>;
    get(runId: string): Promise<WorkflowRunLike | null>;
    waitFor?(runId: string, options?: { timeout?: number }): Promise<WorkflowRunLike>;
    shutdown?(): void;
  };
  start(input: unknown, options?: WorkflowStartOptions): Promise<WorkflowRunLike>;
  resume(runId: string, payload?: unknown): Promise<WorkflowRunLike>;
  cancel(runId: string, options?: { reason?: string }): Promise<WorkflowRunLike>;
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
      /**
       * Tenant-scoped lookup by id. Used by the DELETE handler for a
       * defense-in-depth pre-flight: streamline 2.3.3's `wf.get(runId)` /
       * `engine.get` does NOT accept tenant options, so a cross-tenant
       * runId can leak data through the engine path. Going through the
       * repository here means mongokit's tenant-filter plugin scopes the
       * read — cross-tenant requests get a clean 404 and DELETEs only
       * touch rows the caller actually owns.
       */
      getById?(id: string, options?: Record<string, unknown>): Promise<WorkflowRunLike | null>;
      /**
       * Hard-delete a run by id. Routed through mongokit's inherited
       * `Repository.delete()` so multi-tenant scope + audit/cache plugins
       * fire. Wired into `DELETE /:workflowId/runs/:runId` — operator
       * escape hatch for dead-lettered or stuck rows.
       */
      delete?(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };
    /**
     * Streamline >= 2.3.2 — explicit deploy-time index sync (TTL on
     * terminal runs + tenant compounds). When the host configured
     * `createContainer({ retention })`, arc's app-level deploy hook
     * should call `await container.syncRetentionIndexes()` after
     * `mongoose.connect`. Optional so older streamline versions
     * (and partial mocks) still satisfy the structural shape.
     */
    syncRetentionIndexes?: () => Promise<void>;
    /**
     * Streamline >= 2.3.2 — stop background sweepers and release timers.
     * Arc's `onClose` hook below calls this on every workflow's container
     * during graceful shutdown so SIGTERM doesn't leave the stale-run
     * sweeper running. Optional + idempotent.
     */
    dispose?: () => void;
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
  /**
   * Streamline >= 2.3.3 — pinned definition version (semver) the run
   * started under. Hosts surfacing a "stuck on old version" UI read this
   * to decide whether to nudge a migration. Optional for back-compat
   * with runs created before 2.3.3.
   */
  definitionVersion?: string;
  /**
   * Streamline >= 2.3.3 — count of stale-recovery / sweeper transitions
   * applied to this run. Sweeper dead-letters once this hits
   * `RetentionOptions.maxStaleRecoveries`; UIs can highlight runs trending
   * toward dead-letter.
   */
  recoveryAttempts?: number;
  /**
   * Streamline >= 2.7 — operator-supplied cancellation reason, set when
   * `cancel(runId, { reason })` was called. Absent on runs cancelled without
   * a reason or under older streamline. Surfaced so dashboards can show WHY.
   */
  cancellationReason?: string;
}

/**
 * Streamline >= 2.3.3 dead-letter discriminator. The run.status stays
 * `'failed'`; the discrimination is `error.code`:
 *   - `'stale_heartbeat'` — sweeper terminated; transient crash signal.
 *   - `'dead_lettered'`   — exceeded `maxStaleRecoveries`; permanent.
 *   - `'VERSION_MISMATCH'` — engine deployed a step graph the run can't
 *     resume against; admin must rewind / migrate / cancel.
 *
 * Hosts switch on `error.code` for dashboards / alerting.
 */
export const STREAMLINE_FAILURE_CODES = {
  STALE_HEARTBEAT: "stale_heartbeat",
  DEAD_LETTERED: "dead_lettered",
  VERSION_MISMATCH: "VERSION_MISMATCH",
} as const;

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
   *     cancelled, recovered, retry, compensating, paused (>= 2.7)
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
  // streamline >= 2.7 operator pause (NON-terminal — the run resumes after).
  "workflow:paused",
  // Engine telemetry
  "engine:error",
  "scheduler:error",
  "scheduler:circuit-open",
] as const;

/**
 * Non-durable streaming frames from streamline >= 2.6's `ctx.stream(frame)`
 * (LLM tokens, percent-complete, live previews).
 *
 * Delivered on the SSE endpoint ONLY — deliberately excluded from
 * `STREAMLINE_BUS_EVENTS` / `bridgeBusEvents` because frames are
 * high-frequency, at-most-once UI traffic, not domain events: republishing
 * every token onto arc's Redis/Kafka transport would flood it. Subscribers
 * that genuinely want frames on the transport can bridge
 * `streamline:step.stream` from streamline's own arc-shape transport.
 *
 * On streamline < 2.6 the subscription is a structural no-op (the bus never
 * emits the event) — no version gate needed.
 */
export const STREAMLINE_STREAM_EVENTS = ["step:stream"] as const;

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

/**
 * Terminal run STATUSES (distinct from the terminal EVENT names above).
 * Mirrors streamline's `isTerminalState()` — a run in one of these will
 * emit no further bus events, so the SSE handler sends its snapshot and
 * closes immediately rather than holding a connection open on a dead run.
 */
export const TERMINAL_RUN_STATUSES = new Set<string>(["done", "failed", "cancelled"]);

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

  // The plugin is wrapped in `fastify-plugin` (see export below) so
  // Fastify does NOT treat `options.prefix` as an encapsulation prefix.
  // That means routes use `options.prefix` directly here — no duplicate
  // prefix when the host passes `register(plugin, { prefix: '/api/...' })`.
  const routeScope = prefix;

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

  // ============ Per-run handlers and tenant scope ============
  //
  // streamline's per-run engine methods (`engine.get`, `engine.cancel`,
  // `engine.resume`, `engine.execute`, `engine.pause`, `engine.rewindTo`,
  // `engine.waitFor`) do NOT accept a tenant-options argument — they walk
  // the cache and call `repository.getById(runId)` without forwarding
  // tenant scope.
  //
  // Arc therefore enforces tenant OWNERSHIP at the HTTP boundary: when a
  // `tenantResolver` is configured (and the request isn't bypassing), every
  // per-run route below first does a tenant-scoped `repository.getById`
  // pre-flight. A runId belonging to another tenant gets a clean 404 —
  // identical to "doesn't exist", so cross-tenant probing leaks nothing.
  // Without a `tenantResolver` (single-tenant / staticTenantId deployments)
  // the pre-flight is skipped and behavior is unchanged.
  for (const [id, wf] of registry) {
    const routePrefix = `${routeScope}/${id}`;

    // Tenant-ownership pre-flight for per-run routes. Bound to the repo —
    // mongokit Repository methods use `this` (tenant-filter plugin, cache);
    // called detached they 500 on `this._buildContext`.
    const visibilityRepo = wf.container?.repository as
      | { getById?: (id: string, opts?: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    const visibilityGetById = visibilityRepo?.getById?.bind(visibilityRepo);
    const assertRunVisible = async (request: FastifyRequest, runId: string): Promise<void> => {
      if (!visibilityGetById) return; // structural repo without getById — preserve old behavior
      const tenantOpts = resolveTenantOpts(request);
      // Only enforce when the request actually carries tenant scope. Bypass
      // requests are cross-tenant by declaration; tenantless deployments
      // (no tenantResolver) keep the pre-2.18 behavior byte-for-byte.
      if (tenantOpts.bypassTenant || tenantOpts.tenantId === undefined) return;
      const existing = await visibilityGetById(runId, { tenantId: tenantOpts.tenantId });
      if (!existing) throw new NotFoundError("Workflow run", runId);
    };

    // POST /:workflowId/start — Start a new workflow run
    fastify.post(`${routePrefix}/start`, { preHandler: authPreHandler }, async (request, reply) => {
      if (!(await checkPerm("start", request))) {
        throw new ForbiddenError();
      }

      // Envelope validation. The handler accepts `{ input, meta, idempotencyKey,
      // priority }` — every workflow payload nests under `input`. Historically,
      // callers who passed their workflow fields directly (`{ orderId: '...' }`
      // instead of `{ input: { orderId: '...' } }`) hit a downstream
      // streamline validator that surfaced as a cryptic `"Invalid Date"` 400.
      // Reject the mistake here with a 422 + actionable message so the DX
      // pointer is immediate.
      const body = request.body;
      if (body !== null && body !== undefined && typeof body !== "object") {
        throw createError(422, `[Arc/Streamline] '/${id}/start' body must be a JSON object.`, {
          code: "arc.streamline.invalid_body",
          workflowId: id,
        });
      }
      const envelopeKeys = new Set(["input", "meta", "idempotencyKey", "priority"]);
      const bodyRecord = (body ?? {}) as Record<string, unknown>;
      const presentKeys = Object.keys(bodyRecord);
      const unknownKeys = presentKeys.filter((k) => !envelopeKeys.has(k));
      const hasInputKey = Object.hasOwn(bodyRecord, "input");
      if (unknownKeys.length > 0 && !hasInputKey) {
        // The caller passed workflow fields at the top level instead of
        // wrapping them in `{ input: { ... } }`. Surface the canonical
        // shape so they don't have to chase the downstream validator.
        throw createError(
          422,
          `[Arc/Streamline] '/${id}/start' expects '{ input: {...} }'. ` +
            `Got top-level keys [${unknownKeys.join(", ")}] but no 'input' key. ` +
            `Wrap your workflow payload: { "input": { ${unknownKeys
              .map((k) => `"${k}": ...`)
              .join(", ")} } }.`,
          {
            code: "arc.streamline.missing_input_envelope",
            workflowId: id,
            received: unknownKeys,
            expected: "input",
          },
        );
      }
      if (unknownKeys.length > 0) {
        // `input` is present but the caller also included keys outside the
        // envelope. Likely a misplaced field — point at them explicitly so
        // they don't silently flow nowhere.
        throw createError(
          422,
          `[Arc/Streamline] '/${id}/start' got unknown top-level keys [${unknownKeys.join(", ")}]. ` +
            `Allowed envelope keys: input, meta, idempotencyKey, priority. ` +
            `Did you mean to nest these under 'input'?`,
          {
            code: "arc.streamline.unknown_envelope_keys",
            workflowId: id,
            unknown: unknownKeys,
          },
        );
      }

      const { input, meta, idempotencyKey, priority } = bodyRecord as {
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
        await assertRunVisible(request, runId);
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
        await assertRunVisible(request, runId);
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
        await assertRunVisible(request, runId);
        // streamline >= 2.7: forward an optional operator reason (persisted on
        // the run + echoed in the workflow:cancelled event). Absent → undefined,
        // which pre-2.7 engines ignore.
        const { reason: cancelReason } = (request.body ?? {}) as { reason?: string };
        const run = await wf.cancel(
          runId,
          cancelReason !== undefined ? { reason: cancelReason } : undefined,
        );

        if (bridgeEvents && fastify.events?.publish) {
          try {
            await fastify.events.publish(`workflow.${id}.cancelled`, {
              runId: run._id,
              workflowId: id,
              ...(cancelReason !== undefined ? { reason: cancelReason } : {}),
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
        await assertRunVisible(request, runId);
        const run = await wf.engine.execute(runId);
        return run;
      },
    );

    // DELETE /:workflowId/runs/:runId — Hard-delete a workflow run.
    //
    // Operator escape hatch for dead-lettered / wedged rows that
    // shouldn't sit in the collection waiting for TTL. The handler:
    //   1. Tenant-scoped existence check via `repository.getById` (NOT
    //      `wf.get` — engine.get bypasses the tenant filter). Returns 404
    //      both for "doesn't exist" and "exists in another tenant" — same
    //      response on purpose (no existence-leak across tenants).
    //   2. Best-effort cancel so listening compensation hooks fire;
    //      swallows "already terminal" errors — the delete is the
    //      load-bearing intent.
    //   3. Repository-level delete with tenant scope so the multi-tenant
    //      plugin actually narrows the write. 204 on success.
    //
    // Reuses the `cancel` permission slot — deletion is strictly more
    // destructive than cancel, so anyone authorized to cancel is
    // implicitly authorized to delete. Hosts that want a separate gate
    // should add their own preHandler.
    type DeleteRepo = {
      getById?: (id: string, opts?: Record<string, unknown>) => Promise<WorkflowRunLike | null>;
      delete?: (id: string, opts?: Record<string, unknown>) => Promise<unknown>;
    };
    const deleteRepo = wf.container?.repository as DeleteRepo | undefined;
    // Both methods required: the tenant-scoped pre-flight is the load-
    // bearing security gate, so a repo that ships `delete` without
    // `getById` is structurally incomplete and the route stays unmounted.
    //
    // Bind to the repo: these are mongokit `Repository` instance methods that
    // use `this` (`this._buildContext`, the tenant-filter plugin, cache). Pulled
    // off the object and called detached, `this` is `undefined` and the handler
    // 500s with "Cannot read properties of undefined (reading '_buildContext')".
    const repoDeleteFn = deleteRepo?.delete?.bind(deleteRepo);
    const repoGetByIdFn = deleteRepo?.getById?.bind(deleteRepo);
    if (repoDeleteFn && repoGetByIdFn) {
      fastify.delete(
        `${routePrefix}/runs/:runId`,
        { preHandler: authPreHandler },
        async (request, reply) => {
          if (!(await checkPerm("cancel", request))) {
            throw new ForbiddenError();
          }
          const { runId } = request.params as { runId: string };
          const tenantOpts = resolveTenantOpts(request);
          const repoOpts = {
            ...(tenantOpts.tenantId !== undefined ? { tenantId: tenantOpts.tenantId } : {}),
            ...(tenantOpts.bypassTenant ? { bypassTenant: true } : {}),
          };

          const existing = await repoGetByIdFn(runId, repoOpts);
          if (!existing) throw new NotFoundError(`Workflow run ${runId} not found`);

          try {
            await wf.cancel(runId);
          } catch {
            // already done/failed/cancelled — fall through to delete
          }

          await repoDeleteFn(runId, repoOpts);
          return reply.status(204).send();
        },
      );
    }

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
          await assertRunVisible(request, runId);
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
          await assertRunVisible(request, runId);
          // streamline >= 2.7: optional operator reason, same shape as cancel.
          const { reason: pauseReason } = (request.body ?? {}) as { reason?: string };
          const run = await wf.engine.pause?.(
            runId,
            pauseReason !== undefined ? { reason: pauseReason } : undefined,
          );
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
          await assertRunVisible(request, runId);
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
        {
          // Browser EventSource can't send headers — arc-next passes the bearer as
          // `?token=`. Promote it into the Authorization header BEFORE auth runs so
          // the stream authenticates in bearer mode (no-op when a header is present).
          preHandler: [
            async (request: FastifyRequest) => {
              promoteStreamTokenToHeader(request);
            },
            ...authPreHandler,
          ],
        },
        async (request, reply) => {
          if (!(await checkPerm("get", request))) {
            throw new ForbiddenError();
          }

          const { runId } = request.params as { runId: string };
          await assertRunVisible(request, runId);
          const run = await wf.get(runId);
          if (!run) {
            throw new NotFoundError("Workflow run", runId);
          }

          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            // Defeat proxy buffering (nginx) so events aren't held back.
            "X-Accel-Buffering": "no",
            // Carry over CORS / Vary headers @fastify/cors set on the reply — the
            // raw writeHead bypasses Fastify's onSend chain, so a cross-origin
            // EventSource would otherwise get no Access-Control-Allow-Origin.
            ...forwardedStreamHeaders(reply),
          });
          // Flush the head IMMEDIATELY. Without this, Node holds the response
          // head until the first body write — and since we only write on a
          // live bus event, a subscriber connecting during a long-running
          // step (or after the run already finished) would receive zero bytes
          // and its EventSource `onopen` would never fire. Flushing here makes
          // the connection observably open the instant it's accepted.
          reply.raw.flushHeaders();

          // Stream every streamline bus event — run-scoped filter applied
          // per-event. Terminal events auto-close the stream.
          const terminalEvents = new Set<string>(STREAMLINE_TERMINAL_EVENTS);
          const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
          let closed = false;
          let heartbeat: ReturnType<typeof setInterval> | undefined;

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
            if (heartbeat) clearInterval(heartbeat);
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

          // Snapshot-on-connect: emit the current run document as the first
          // event so a subscriber that joins mid-run (or after a step has
          // already transitioned) sees the live state instead of waiting for
          // the NEXT transition — which may be seconds away, or never come.
          send("workflow:snapshot", run);

          // If the run is ALREADY terminal at connect time, no further bus
          // events will fire for it — send the snapshot (above) and close,
          // so a late subscriber doesn't hang forever waiting on a dead run.
          const runStatus = (run as { status?: string }).status;
          if (runStatus && TERMINAL_RUN_STATUSES.has(runStatus)) {
            cleanup();
            return;
          }

          // Heartbeat comment every 15s. Keeps the connection alive through
          // idle-timeout proxies and lets the client tell "connected but
          // quiet" (long step) apart from "dead". SSE comments (`:`-prefixed)
          // are ignored by EventSource, so this is invisible to consumers.
          // `unref` so the timer never keeps the process alive on its own.
          heartbeat = setInterval(() => {
            if (closed) return;
            try {
              reply.raw.write(`: ping\n\n`);
            } catch {
              cleanup();
            }
          }, 15_000);
          (heartbeat as { unref?: () => void }).unref?.();

          // Lifecycle/telemetry events PLUS live `ctx.stream()` frames
          // (streamline >= 2.6; structural no-op on older versions). Frames
          // are SSE-only by design — see STREAMLINE_STREAM_EVENTS.
          for (const eventName of [...STREAMLINE_BUS_EVENTS, ...STREAMLINE_STREAM_EVENTS]) {
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
      `${routeScope}/hooks/:token`,
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
  fastify.get(routeScope || "/", { preHandler: authPreHandler }, async () => {
    const list = Array.from(registry.entries()).map(([id, wf]) => ({
      id,
      name: wf.definition.name ?? id,
      steps: Array.isArray(wf.definition.steps)
        ? wf.definition.steps.map((s: unknown) => (s as { id?: string }).id ?? String(s))
        : Object.keys(wf.definition.steps),
    }));
    return list;
  });

  // Graceful shutdown — stop the engine's scheduler AND the container's
  // retention sweeper (streamline >= 2.3.2). `dispose()` is idempotent and
  // optional on the structural shape so older streamline versions are a
  // no-op here.
  fastify.addHook("onClose", async () => {
    for (const wf of registry.values()) {
      wf.shutdown?.();
      wf.container?.dispose?.();
    }
  });
};

/**
 * Pluggable streamline integration for Arc.
 *
 * Wrapped in `fastify-plugin` so Fastify treats `options.prefix` as a
 * plain plugin option (NOT an encapsulation prefix). Without the wrapper,
 * Fastify would prepend `options.prefix` to every route, then the plugin
 * code would prepend it again — the duplicate-prefix bug.
 */
export const streamlinePlugin = fp(streamlinePluginImpl, {
  name: "streamline-routes",
  fastify: "5.x",
});
