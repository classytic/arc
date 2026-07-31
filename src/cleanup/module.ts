/**
 * `createDataCleanupModule` — mounts the Data Cleanup Center as an Arc module
 * (data-cleanup design §6.5 contract).
 *
 * The host injects the recipes + durable ports; this factory builds the
 * registry (boot-time uniqueness) + orchestration service and exposes them as
 * the module's public export, plus a single operations resource:
 *
 *   GET  {prefix}/recipes         — recipe cards (introspection) [view]
 *   POST {prefix}/preview         — plan + digest, no mutation     [view]
 *   POST {prefix}/runs            — execute a confirmed plan (202) [execute]
 *   GET  {prefix}/runs/:id        — observe a run                  [view]
 *   POST {prefix}/runs/:id/action — cancel | retry                 [manage]
 *
 * The resource has NO Mongo model — run/evidence persistence is the injected
 * ports' job (the host owns the collections). Routes are `raw` Fastify handlers
 * with route-level `permissions` AND Fastify JSON-Schema validation (`schema`);
 * thrown `CleanupError`s carry `statusCode`/`code` so arc's error handler maps
 * them without a per-host mapper.
 *
 * Route schemas are plain JSON Schema (not Zod) on purpose: `zod` is an OPTIONAL
 * arc peer and this subpath is always-loaded, so importing zod here would make
 * it a de-facto requirement for every cleanup consumer. Arc's `convertRouteSchema`
 * accepts either form; a host that prefers Zod can override at its own edge.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { defineResource } from "../core/defineResource.js";
import { defineModule } from "../factory/module/index.js";
import type { ArcModule } from "../factory/module/types.js";
import type { PermissionCheck } from "../permissions/types.js";
import { getUserId } from "../scope/types.js";
import type { RequestWithExtras } from "../types/fastify.js";
import { CleanupErrors } from "./errors.js";
import { createCleanupRegistry } from "./registry.js";
import { type CleanupService, createCleanupService } from "./service.js";
import type {
  CleanupEvidenceStore,
  CleanupJobQueue,
  CleanupLimits,
  CleanupPermissions,
  CleanupRecipe,
  CleanupRunStore,
  CleanupWriteFence,
  PurgeActor,
} from "./types.js";

export interface DataCleanupModuleDeps {
  /** The recipes this deployment exposes. Ids must be unique (boot-checked). */
  recipes: readonly CleanupRecipe[];
  /** Durable run store — host-owned persistence (atomic create + CAS transitions). */
  runStore: CleanupRunStore;
  /** Durable evidence + manifest store — host-owned, idempotent by operationId. */
  evidenceStore: CleanupEvidenceStore;
  /** Permission checks for view / execute / manage. */
  permissions: CleanupPermissions;
  /** Optional write fence (§8). */
  writeFence?: CleanupWriteFence | undefined;
  /** Optional durable job queue (§8) — defaults to microtask-deferred in-process. */
  jobQueue?: CleanupJobQueue | undefined;
  /** Framework size caps. */
  limits?: Partial<CleanupLimits> | undefined;
  /** Exclusive worker-lease duration (ms). Default 5 minutes. */
  leaseMs?: number | undefined;
  /** Min interval between persisted progress writes (ms). Default 0 (every chunk). */
  progressThrottleMs?: number | undefined;
  /** Route prefix. Default `/governance/data-cleanup`. */
  prefix?: string | undefined;
  /** Module name. Default `data-cleanup`. */
  moduleName?: string | undefined;
  /** App resource names this module supersedes. */
  owns?: readonly string[] | undefined;
  /**
   * Derive the acting party from the request. Default reads `getUserId(req.scope)`
   * (falling back to `req.user.id`) and FAILS CLOSED — a destructive governance
   * action with no resolvable authenticated actor throws `CLEANUP_ACTOR_REQUIRED`
   * (401) rather than attributing the purge to `user:unknown`.
   */
  resolveActor?: (req: RequestWithExtras) => PurgeActor;
  /**
   * Capture the request's serializable ambient scope (branch/company target) so
   * the worker rebuilds the exact operation context. Must be JSON-serializable.
   */
  resolveAmbient?: (req: RequestWithExtras) => Readonly<Record<string, unknown>> | undefined;
  /** Injected id generator (tests). */
  generateId?: () => string;
  /** Injected clock (tests). */
  now?: () => Date;
}

function defaultResolveActor(req: RequestWithExtras): PurgeActor {
  const id =
    (req.scope ? getUserId(req.scope) : undefined) ?? (req.user as { id?: string } | undefined)?.id;
  if (!id) throw CleanupErrors.actorRequired();
  return { ref: `user:${id}`, kind: "user" };
}

const recipeIdSchema = { type: "string", minLength: 1, maxLength: 200 } as const;
const parametersSchema = { type: "object", additionalProperties: true } as const;

const previewBodySchema = {
  type: "object",
  required: ["recipe"],
  additionalProperties: false,
  properties: { recipe: recipeIdSchema, parameters: parametersSchema },
} as const;

const runsBodySchema = {
  type: "object",
  required: ["recipe", "planDigest", "reason"],
  additionalProperties: false,
  properties: {
    recipe: recipeIdSchema,
    parameters: parametersSchema,
    planDigest: { type: "string", minLength: 1, maxLength: 128 },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
    confirmation: { type: "string", maxLength: 500 },
  },
} as const;

const runIdParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

const actionBodySchema = {
  type: "object",
  required: ["action"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["cancel", "retry"] },
    /** Optional cancel justification — persisted on the run + evidence. */
    reason: { type: "string", maxLength: 2000 },
  },
} as const;

/**
 * Build the Data Cleanup Center Arc module. The module's public export is the
 * live {@link CleanupService} (so other modules / tests can drive it directly).
 */
export function createDataCleanupModule(deps: DataCleanupModuleDeps): ArcModule<CleanupService> {
  const registry = createCleanupRegistry(deps.recipes);
  const service = createCleanupService({
    registry,
    runStore: deps.runStore,
    evidenceStore: deps.evidenceStore,
    writeFence: deps.writeFence,
    jobQueue: deps.jobQueue,
    limits: deps.limits,
    leaseMs: deps.leaseMs,
    progressThrottleMs: deps.progressThrottleMs,
    generateId: deps.generateId,
    now: deps.now,
  });
  const prefix = deps.prefix ?? "/governance/data-cleanup";
  const resolveActor = deps.resolveActor ?? defaultResolveActor;
  const resolveAmbient = deps.resolveAmbient;
  const view = deps.permissions.view as PermissionCheck;
  const execute = deps.permissions.execute as PermissionCheck;
  const manage = (deps.permissions.manage ?? deps.permissions.execute) as PermissionCheck;

  const resource = defineResource({
    name: deps.moduleName ?? "data-cleanup",
    displayName: "Data Cleanup Center",
    tag: "Governance",
    prefix,
    // Operations API, no Mongo model — persistence is via injected ports.
    customRoutesOnly: true,
    routes: [
      {
        method: "GET",
        path: "/recipes",
        summary: "List available cleanup recipes",
        permissions: view,
        rawHandler: async (_req: FastifyRequest, reply: FastifyReply) => {
          return reply.send({ recipes: registry.introspect() });
        },
      },
      {
        method: "POST",
        path: "/preview",
        summary: "Preview a cleanup plan (no mutation)",
        permissions: view,
        schema: { body: previewBodySchema },
        rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          const r = req as RequestWithExtras;
          const body = req.body as { recipe: string; parameters?: Record<string, unknown> };
          const plan = await service.preview({
            recipeId: body.recipe,
            parameters: body.parameters,
            actor: resolveActor(r),
            ambient: resolveAmbient?.(r),
          });
          return reply.send(plan);
        },
      },
      {
        method: "POST",
        path: "/runs",
        summary: "Execute a confirmed cleanup plan",
        permissions: execute,
        schema: { body: runsBodySchema },
        rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          const r = req as RequestWithExtras;
          const body = req.body as {
            recipe: string;
            parameters?: Record<string, unknown>;
            planDigest: string;
            reason: string;
            confirmation?: string;
          };
          const run = await service.execute({
            recipeId: body.recipe,
            parameters: body.parameters,
            planDigest: body.planDigest,
            reason: body.reason,
            confirmation: body.confirmation,
            actor: resolveActor(r),
            ambient: resolveAmbient?.(r),
          });
          return reply.status(202).send(run);
        },
      },
      {
        method: "GET",
        path: "/runs/:id",
        summary: "Observe a cleanup run",
        permissions: view,
        schema: { params: runIdParamsSchema },
        rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          return reply.send(await service.getRun(id));
        },
      },
      {
        method: "POST",
        path: "/runs/:id/action",
        summary: "Cancel or retry a cleanup run",
        permissions: manage,
        schema: { params: runIdParamsSchema, body: actionBodySchema },
        rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
          // Attribution is required for a control action (fail-closed).
          const actionActor = resolveActor(req as RequestWithExtras);
          const { id } = req.params as { id: string };
          const { action, reason } = req.body as { action: "cancel" | "retry"; reason?: string };
          if (action === "cancel") {
            return reply.send(await service.cancel(id, { actor: actionActor, reason }));
          }
          return reply.send(await service.retry(id));
        },
      },
    ],
  });

  return defineModule<CleanupService>({
    name: deps.moduleName ?? "data-cleanup",
    ...(deps.owns ? { owns: deps.owns } : {}),
    bootstrap: () => service,
    resources: () => [resource],
  });
}
