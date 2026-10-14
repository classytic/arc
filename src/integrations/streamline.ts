/**
 * Streamline integration — wires `@classytic/streamline` workflows into arc.
 *
 * REST endpoints for workflow management, auto-connected to arc's event bus,
 * honouring arc auth/permissions and surfacing streamline's repo-core-aligned
 * `HttpError`s with their real status codes rather than a blanket 500.
 *
 * A separate subpath, loaded only when used:
 * `@classytic/arc/integrations/streamline`. Peer: `@classytic/streamline`.
 *
 * Routes mounted under `prefix`: `POST /:workflow/start`,
 * `GET /:workflow/runs[/:runId]`, `POST /:workflow/runs/:runId/{resume,cancel}`,
 * and `POST /hooks/:token` when `enableHookEndpoint` is set.
 *
 * @example
 * ```typescript
 * await fastify.register(streamlinePlugin, {
 *   workflows: [orderWorkflow],
 *   prefix: '/api/workflows',
 *   tenantResolver: (req) => req.user?.organizationId,
 * });
 * ```
 */
import { ARC_ERROR_CODES } from "@classytic/repo-core/errors";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { createError, ForbiddenError, NotFoundError } from "../utils/errors.js";
import { forwardedStreamHeaders, promoteStreamTokenToHeader } from "../utils/streaming.js";

// ============================================================================
// Types (structural, so the subpath imports without streamline installed)
// ============================================================================

/**
 * Start options — matches streamline's `StartOptions`. `tenantId` /
 * `bypassTenant` must come from auth context (`tenantResolver`), never the
 * request body.
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
    // `reason` is persisted on the run and echoed in workflow:cancelled.
    cancel(runId: string, options?: { reason?: string }): Promise<WorkflowRunLike>;
    pause?(runId: string, options?: { reason?: string }): Promise<WorkflowRunLike>;
    rewindTo?(runId: string, stepId: string): Promise<WorkflowRunLike>;
    get(runId: string): Promise<WorkflowRunLike | null>;
    waitFor?(runId: string, options?: { timeout?: number }): Promise<WorkflowRunLike>;
    shutdown?(): void;
    /**
     * Read for `compensationHandlers` only — whether a failed run will roll
     * back, which decides if `workflow:failed` ends its stream. Absent = no saga.
     */
    options?: { compensationHandlers?: unknown };
  };
  start(input: unknown, options?: WorkflowStartOptions): Promise<WorkflowRunLike>;
  resume(runId: string, payload?: unknown): Promise<WorkflowRunLike>;
  cancel(runId: string, options?: { reason?: string }): Promise<WorkflowRunLike>;
  get(runId: string): Promise<WorkflowRunLike | null>;
  shutdown?(): void;
  /** Streamline container for event bridging + repository access. */
  container?: {
    eventBus: {
      on(event: string, listener: (...args: unknown[]) => void): void;
      off(event: string, listener: (...args: unknown[]) => void): void;
    };
    /** Repository — used by the list-runs endpoint to query workflow_runs. */
    repository?: {
      getAll(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
      /**
       * Tenant-scoped lookup — the per-run ownership pre-flight. The engine's
       * `get` takes no tenant options, so the tenant-filtered repository read
       * is what stops cross-tenant access (clean 404).
       */
      getById?(id: string, options?: Record<string, unknown>): Promise<WorkflowRunLike | null>;
      /** Tenant-scoped hard delete, backing `DELETE /:workflowId/runs/:runId`. */
      delete?(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };
    /**
     * Deploy-time index sync (retention TTL + tenant compounds). Hosts using
     * `createContainer({ retention })` call it after connecting.
     */
    syncRetentionIndexes?: () => Promise<void>;
    /** Stop background sweepers; called on `onClose`. Idempotent. */
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
  /** Definition version (semver) the run started under. */
  definitionVersion?: string;
  /** Stale-recovery transitions so far; dead-lettered at `maxStaleRecoveries`. */
  recoveryAttempts?: number;
  /** Reason passed to `cancel(runId, { reason })`, if any. */
  cancellationReason?: string;
}

/**
 * Dead-letter discriminator: `run.status` stays `'failed'`; `error.code` says why:
 *   - `'stale_heartbeat'` — sweeper terminated; transient crash signal.
 *   - `'dead_lettered'`   — exceeded `maxStaleRecoveries`; permanent.
 *   - `'VERSION_MISMATCH'` — engine deployed a step graph the run can't
 *     resume against; admin must rewind / migrate / cancel.
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
   * Bridge every {@link STREAMLINE_BUS_EVENTS} event (step, workflow
   * lifecycle, engine telemetry) from `container.eventBus` to Arc's event bus
   * as `workflow.${workflowId}.${eventName}`.
   * @default false
   */
  bridgeBusEvents?: boolean;
  /**
   * Enable SSE streaming endpoint: GET /:workflowId/runs/:runId/stream
   * Streams step-level + lifecycle events as Server-Sent Events for live
   * UI updates. Auto-closes the stream when the run ends: completed /
   * cancelled / compensated / compensation_failed, and failed only for a
   * workflow with no compensation (a saga keeps streaming its rollback).
   * @default false
   */
  enableStreaming?: boolean;
  /**
   * Enable `POST /hooks/:token` (at the prefix root — the token encodes the
   * runId), routed through streamline's `resumeHook(token, body)`, which
   * validates against the waiting step's stored `hookToken` (fail-closed).
   * Workflows MUST pass `{ hookToken: hook.token }` to `ctx.wait(...)`.
   *
   * The token IS the authentication; `auth` adds a user gate on top.
   * @default false
   */
  enableHookEndpoint?: boolean;
  /**
   * Resolve the request's tenant id from auth context — NEVER the request
   * body. Forwarded to streamline calls, and enables the per-run tenant
   * ownership check. `undefined` skips tenant scoping.
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
  /**
   * Custom permission check for workflow operations. `execute` falls back to
   * `start`, and `pause` / `rewind` to `cancel`, when not set — so restricting
   * the broader operation also covers these.
   */
  permissions?: {
    start?: (request: unknown) => boolean | Promise<boolean>;
    resume?: (request: unknown) => boolean | Promise<boolean>;
    cancel?: (request: unknown) => boolean | Promise<boolean>;
    list?: (request: unknown) => boolean | Promise<boolean>;
    get?: (request: unknown) => boolean | Promise<boolean>;
    execute?: (request: unknown) => boolean | Promise<boolean>;
    pause?: (request: unknown) => boolean | Promise<boolean>;
    rewind?: (request: unknown) => boolean | Promise<boolean>;
  };
  /**
   * Operations whose call requires an idempotency key (400 `arc.idempotency_key_required`
   * when absent; a keyed retry replays). `workflows` narrows it to those ids (default: all).
   * On `start` the header key IS the run's `idempotencyKey`; a different body key is refused.
   * Needs `idempotencyPlugin` enabled.
   */
  idempotency?: {
    readonly required: readonly ("start" | "execute" | "resume" | "rewind")[];
    readonly workflows?: readonly string[];
  };
}

// ============================================================================
// Streamline event names — raw names on `container.eventBus`
// ============================================================================

/**
 * Events published on a streamline workflow's internal `eventBus`. Subscribing
 * to one the running version doesn't emit is a no-op. Pinned against
 * streamline's `ALL_WORKFLOW_EVENT_NAMES` by `tests/integrations/streamline-drift.test.ts`.
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
  "workflow:paused", // NON-terminal
  // Saga outcomes — emitted under a computed name, so a grep for `emit('…')` misses them.
  "workflow:compensated",
  "workflow:compensation_failed",
  // Engine telemetry
  "engine:error",
  "scheduler:error",
  "scheduler:circuit-open",
] as const;

/**
 * Non-durable `ctx.stream(frame)` frames (LLM tokens, progress). SSE ONLY —
 * excluded from `bridgeBusEvents` because high-frequency at-most-once UI
 * traffic would flood arc's event transport.
 */
export const STREAMLINE_STREAM_EVENTS = ["step:stream"] as const;

/**
 * Workflow events that end a run and auto-close an SSE stream.
 *
 * `workflow:failed` is terminal ONLY without compensation handlers: a saga
 * emits `failed` THEN rolls back, so closing there would hide the rollback.
 * See {@link isStreamTerminal}.
 */
export const STREAMLINE_TERMINAL_EVENTS = [
  "workflow:completed",
  "workflow:failed",
  "workflow:cancelled",
  "workflow:compensated",
  "workflow:compensation_failed",
] as const;

/**
 * Terminal run STATUSES (vs. the event names above). A run in one emits no
 * further events, so SSE sends its snapshot and closes. Pinned against
 * streamline's own list by `tests/integrations/streamline-drift.test.ts`.
 */
export const TERMINAL_RUN_STATUSES = new Set<string>([
  "done",
  "failed",
  "cancelled",
  "compensated",
  "compensation_failed",
]);

/** Whether a workflow rolls back on failure (has any `onCompensate` step). */
function hasCompensation(wf: WorkflowLike): boolean {
  const handlers = wf.engine.options?.compensationHandlers;
  return !!handlers && typeof handlers === "object" && Object.keys(handlers).length > 0;
}

/**
 * Whether a run has ended, for the purpose of closing its stream — by event
 * name or by status. `failed` ends a run only when nothing will compensate it.
 */
export function isStreamTerminal(
  eventOrStatus: string,
  compensates: boolean,
  kind: "event" | "status",
): boolean {
  if (kind === "event") {
    if (eventOrStatus === "workflow:failed") return !compensates;
    return (STREAMLINE_TERMINAL_EVENTS as readonly string[]).includes(eventOrStatus);
  }
  if (eventOrStatus === "failed") return !compensates;
  return TERMINAL_RUN_STATUSES.has(eventOrStatus);
}

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
    idempotency,
  } = options;

  // fp-wrapped, so Fastify does not apply `prefix` itself — routes add it here.
  const routeScope = prefix;

  const bridgeBus = options.bridgeBusEvents ?? false;

  const registry = new Map<string, WorkflowLike>();

  for (const wf of workflows) {
    const id = wf.definition.id;
    if (registry.has(id)) {
      throw new Error(`Duplicate workflow ID: '${id}'`);
    }
    registry.set(id, wf);
  }

  if (!fastify.hasDecorator("workflows")) {
    fastify.decorate("workflows", registry);
  }
  if (!fastify.hasDecorator("getWorkflow")) {
    fastify.decorate("getWorkflow", (id: string) => registry.get(id) ?? null);
  }

  const authPreHandler =
    auth && typeof fastify.authenticate === "function" ? [fastify.authenticate] : [];

  // Tenant id + bypass flag come from the auth context, never the request body.
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

  type PermOp = keyof NonNullable<StreamlinePluginOptions["permissions"]>;
  const PERM_FALLBACK: Partial<Record<PermOp, PermOp>> = {
    execute: "start",
    pause: "cancel",
    rewind: "cancel",
  };
  const checkPerm = async (op: PermOp, request: unknown): Promise<boolean> => {
    const fallback = PERM_FALLBACK[op];
    const check = perms?.[op] ?? (fallback ? perms?.[fallback] : undefined);
    if (!check) return true;
    return check(request);
  };

  type FencedOp = "start" | "execute" | "resume" | "rewind";
  const fencedOps = new Set<string>(idempotency?.required ?? []);
  if (fencedOps.size > 0 && !fastify.hasDecorator("idempotency")) {
    throw new Error(
      "[Arc/Streamline] `idempotency.required` is declared, but idempotencyPlugin is not " +
        "registered — register it (enabled) before streamlinePlugin, or drop the declaration.",
    );
  }
  for (const wfId of idempotency?.workflows ?? []) {
    if (!workflows.some((wf) => wf.definition.id === wfId)) {
      throw new Error(`[Arc/Streamline] idempotency.workflows names unknown workflow '${wfId}'.`);
    }
  }

  /**
   * Route options for a mutating op: a fenced op gets `config.idempotency.required` and
   * runs auth → permission → idempotency, so a refused caller never reaches the key check.
   */
  const routeOpts = (wfId: string, op: FencedOp, permOp: PermOp = op) => {
    const fenced =
      fencedOps.has(op) && (!idempotency?.workflows || idempotency.workflows.includes(wfId));
    if (!fenced) return { preHandler: authPreHandler };
    const permGate = async (request: FastifyRequest): Promise<void> => {
      if (!(await checkPerm(permOp, request))) throw new ForbiddenError();
    };
    return {
      config: { idempotency: { required: true } },
      preHandler: [...authPreHandler, permGate, fastify.idempotency.middleware],
    };
  };

  // No plugin-scoped setErrorHandler: streamline's HttpError-shaped errors map
  // through arc's global handler; a local one would ship a second response shape.

  // Streamline's per-run engine methods take no tenant options, so every
  // per-run route first does a tenant-scoped `repository.getById`. Another
  // tenant's runId gets the same 404 as a missing one — probing leaks nothing.
  for (const [id, wf] of registry) {
    const routePrefix = `${routeScope}/${id}`;

    // Bound: mongokit Repository methods use `this`; called detached they 500.
    const visibilityRepo = wf.container?.repository as
      | { getById?: (id: string, opts?: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    const visibilityGetById = visibilityRepo?.getById?.bind(visibilityRepo);
    const assertRunVisible = async (request: FastifyRequest, runId: string): Promise<void> => {
      if (!visibilityGetById) return;
      const tenantOpts = resolveTenantOpts(request);
      // Enforced only when the request carries tenant scope (bypass is cross-tenant by declaration).
      if (tenantOpts.bypassTenant || tenantOpts.tenantId === undefined) return;
      const existing = await visibilityGetById(runId, { tenantId: tenantOpts.tenantId });
      if (!existing) throw new NotFoundError("Workflow run", runId);
    };

    // POST /:workflowId/start — Start a new workflow run
    fastify.post(`${routePrefix}/start`, routeOpts(id, "start"), async (request, reply) => {
      if (!(await checkPerm("start", request))) {
        throw new ForbiddenError();
      }

      // Workflow payload nests under `input`; reject un-wrapped fields with an
      // actionable 422 (streamline's own validator reports them cryptically).
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

      const {
        input,
        meta,
        idempotencyKey: bodyKey,
        priority,
      } = bodyRecord as {
        input?: unknown;
        meta?: Record<string, unknown>;
        idempotencyKey?: string;
        priority?: number;
      };
      // One operation, one key: the header key and a body `idempotencyKey` must agree.
      const headerKey = request.idempotencyKey;
      if (headerKey !== undefined && bodyKey !== undefined && bodyKey !== headerKey) {
        throw createError(
          422,
          `[Arc/Streamline] '/${id}/start' got an idempotency-key header and a different body ` +
            "`idempotencyKey` — send one key, or the same key in both.",
          { code: ARC_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, workflowId: id },
        );
      }
      const idempotencyKey = bodyKey ?? headerKey;
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

    // GET /:workflowId/runs — paginated; the repository's tenant filter scopes the read.
    // Captured here: TS can't narrow `wf.container?.repository` across the closure.
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

    // POST /:workflowId/runs/:runId/resume — no hook-token validation; token-validated
    // resume is POST /hooks/:token (enableHookEndpoint).
    fastify.post(
      `${routePrefix}/runs/:runId/resume`,
      routeOpts(id, "resume"),
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
      routeOpts(id, "execute"),
      async (request, _reply) => {
        if (!(await checkPerm("execute", request))) {
          throw new ForbiddenError();
        }
        const { runId } = request.params as { runId: string };
        await assertRunVisible(request, runId);
        const run = await wf.engine.execute(runId);
        return run;
      },
    );

    // DELETE /:workflowId/runs/:runId — operator hard-delete for dead-lettered /
    // wedged runs: tenant-scoped existence check (404 either way), best-effort
    // cancel so compensation hooks fire, then tenant-scoped repository delete.
    // Gated by the `cancel` permission; add a preHandler for a separate gate.
    type DeleteRepo = {
      getById?: (id: string, opts?: Record<string, unknown>) => Promise<WorkflowRunLike | null>;
      delete?: (id: string, opts?: Record<string, unknown>) => Promise<unknown>;
    };
    const deleteRepo = wf.container?.repository as DeleteRepo | undefined;
    // Both required — the tenant-scoped getById is the security gate. Bound for
    // the same `this` reason as `visibilityRepo`.
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
          if (!(await checkPerm("pause", request))) {
            throw new ForbiddenError();
          }
          const { runId } = request.params as { runId: string };
          await assertRunVisible(request, runId);
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
        routeOpts(id, "rewind"),
        async (request, _reply) => {
          if (!(await checkPerm("rewind", request))) {
            throw new ForbiddenError();
          }
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
          // Node holds the head until the first body write; without a flush a
          // client connecting during a long step never sees `onopen`.
          reply.raw.flushHeaders();

          const compensates = hasCompensation(wf);
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

          // Snapshot first, so a mid-run subscriber sees current state without
          // waiting for the next transition.
          send("workflow:snapshot", run);

          // Already terminal: no more events will fire — close after the snapshot.
          const runStatus = (run as { status?: string }).status;
          if (runStatus && isStreamTerminal(runStatus, compensates, "status")) {
            cleanup();
            return;
          }

          // SSE comment heartbeat: survives idle-timeout proxies, invisible to EventSource.
          heartbeat = setInterval(() => {
            if (closed) return;
            try {
              reply.raw.write(`: ping\n\n`);
            } catch {
              cleanup();
            }
          }, 15_000);
          (heartbeat as { unref?: () => void }).unref?.();

          for (const eventName of [...STREAMLINE_BUS_EVENTS, ...STREAMLINE_STREAM_EVENTS]) {
            const fn = (payload: unknown) => {
              const p = payload as { runId?: string; [k: string]: unknown };
              // Engine telemetry has no runId — deliver it on every stream of the workflow.
              const isRunEvent = typeof p?.runId === "string";
              if (isRunEvent && p.runId !== runId) return;
              send(eventName, p);

              if (p?.runId === runId && isStreamTerminal(eventName, compensates, "event")) {
                cleanup();
              }
            };
            wf.container?.eventBus.on(eventName, fn);
            listeners.push({ event: eventName, fn });
          }

          request.raw.on("close", cleanup);
        },
      );
    }
  }

  // ============ Opt-in: webhook resume endpoint (see `enableHookEndpoint`) ============
  if (enableHookEndpoint) {
    type ResumeHookFn = (
      token: string,
      payload: unknown,
      options?: { container?: NonNullable<WorkflowLike["container"]> },
    ) => Promise<{ runId: string; run: WorkflowRunLike }>;
    let resumeHookFn: ResumeHookFn | undefined;

    /**
     * The container the token's run lives in. Streamline's DB-fallback resume writes through the DEFAULT
     * connection's repository and strict-concurrency counter unless it is handed the run's container —
     * wrong for a streamline bound to another connection. One distinct container is the common case;
     * several are told apart by which one holds the run.
     */
    const containerForRun = async (runId: string) => {
      const containers = [
        ...new Set([...registry.values()].map((wf) => wf.container).filter((c) => c !== undefined)),
      ];
      if (containers.length <= 1) return containers[0];
      for (const container of containers) {
        try {
          if (await container.repository?.getById?.(runId)) return container;
        } catch {
          // a tenant-scoped repository refuses an unscoped read — try the next container
        }
      }
      return undefined;
    };

    fastify.post(
      `${routeScope}/hooks/:token`,
      { preHandler: authPreHandler },
      async (request, _reply) => {
        // Lazy import keeps streamline out of the module load path.
        if (!resumeHookFn) {
          const streamline = (await import("@classytic/streamline")) as {
            resumeHook: ResumeHookFn;
          };
          resumeHookFn = streamline.resumeHook;
        }
        const { token } = request.params as { token: string };
        const container = await containerForRun(token.split(":")[0] ?? token);
        const result = await resumeHookFn(
          token,
          request.body,
          container ? { container } : undefined,
        );
        return { runId: result.runId, run: result.run };
      },
    );
  }

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

  // Stop the engine scheduler AND the container's retention sweeper.
  fastify.addHook("onClose", async () => {
    for (const wf of registry.values()) {
      wf.shutdown?.();
      wf.container?.dispose?.();
    }
  });
};

/**
 * Streamline integration for Arc. Wrapped in `fastify-plugin` so `prefix` is
 * a plain option, not an encapsulation prefix (which would apply it twice).
 */
export const streamlinePlugin = fp(streamlinePluginImpl, {
  name: "streamline-routes",
  fastify: "5.x",
});
