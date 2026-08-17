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
  /**
   * The recipes this deployment exposes. Ids must be unique (boot-checked).
   *
   * May be a THUNK, and for any host whose recipes are built from live engines it
   * should be. Resolved once, inside `bootstrap` — i.e. after arc has validated the
   * module graph and run every module's bootstrap — instead of while this factory
   * runs during composition.
   *
   * Why that matters beyond tidiness: a host assembles cleanup recipes by folding
   * over its composed modules and calling their `preLivePurge()` / `cleanupSteps()`
   * arms, and those arms read `engine.repositories`. An array forces that fold at
   * composition time, which in turn forces every contributing domain to allocate its
   * engine before arc owns the lifecycle — so a graph that then fails validation
   * leaks every engine built up to that point. A thunk breaks that chain.
   */
  recipes:
    | readonly CleanupRecipe[]
    | (() => readonly CleanupRecipe[] | Promise<readonly CleanupRecipe[]>);
  /**
   * Durable run store — host-owned persistence (atomic create + CAS transitions).
   *
   * Accepts a THUNK for the same reason `recipes` does. A store is backed by a
   * model, and constructing it registers that model — so an eager value forces
   * the host to register `CleanupRun` (and its siblings below) while the module
   * graph is still being composed, before arc has validated it or opened the
   * connection. Everything here is read inside `service()`, which is built on
   * first use at `bootstrap`, so deferral costs nothing.
   */
  runStore: CleanupRunStore | (() => CleanupRunStore | Promise<CleanupRunStore>);
  /** Durable evidence + manifest store — host-owned, idempotent by operationId. */
  evidenceStore:
    | CleanupEvidenceStore
    | (() => CleanupEvidenceStore | Promise<CleanupEvidenceStore>);
  /** Permission checks for view / execute / manage. */
  permissions: CleanupPermissions;
  /** Optional write fence (§8). Thunk-friendly — see {@link runStore}. */
  writeFence?:
    | CleanupWriteFence
    | (() => CleanupWriteFence | Promise<CleanupWriteFence>)
    | undefined;
  /**
   * Optional durable job queue (§8) — defaults to microtask-deferred in-process.
   * Thunk-friendly — see {@link runStore}.
   */
  jobQueue?: CleanupJobQueue | (() => CleanupJobQueue | Promise<CleanupJobQueue>) | undefined;
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
/**
 * Step ids to leave out. Bounded and unique — an unbounded list on a
 * destructive endpoint is a denial-of-service surface, and a duplicate id says
 * nothing a single one does not. Unknown or PROTECTIVE ids are refused by the
 * recipe (CLEANUP_INVALID_EXCLUSION), not stripped here: the route must not
 * decide what an operator may narrow.
 */
const excludeStepsSchema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 200 },
  maxItems: 200,
  uniqueItems: true,
} as const;

const previewBodySchema = {
  type: "object",
  required: ["recipe"],
  additionalProperties: false,
  properties: {
    recipe: recipeIdSchema,
    parameters: parametersSchema,
    excludeSteps: excludeStepsSchema,
  },
} as const;

const runsBodySchema = {
  type: "object",
  required: ["recipe", "planDigest", "reason"],
  additionalProperties: false,
  properties: {
    recipe: recipeIdSchema,
    parameters: parametersSchema,
    excludeSteps: excludeStepsSchema,
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
/**
 * Resolve a value-or-thunk dependency.
 *
 * Narrow on purpose: only a FUNCTION is treated as a factory, and every store
 * this is used for is an object, so there is no shape a caller could pass that
 * is ambiguous between the two.
 */
async function resolve<T>(input: T | (() => T | Promise<T>)): Promise<T>;
async function resolve<T>(input: T | (() => T | Promise<T>) | undefined): Promise<T | undefined>;
async function resolve<T>(input: T | (() => T | Promise<T>) | undefined): Promise<T | undefined> {
  return typeof input === "function" ? await (input as () => T | Promise<T>)() : input;
}

export function createDataCleanupModule(deps: DataCleanupModuleDeps): ArcModule<CleanupService> {
  /**
   * Built on FIRST READ, which is `bootstrap` — never in this factory body.
   *
   * Memoized, so the recipe thunk runs exactly once and the id-uniqueness check
   * still happens at boot (arc calls bootstrap during startup); it simply happens
   * inside arc's lifecycle rather than ahead of it.
   */
  // Async because a host assembles recipes with dynamic imports of the domains that
  // own them; forcing a sync thunk would just push that work back to composition,
  // which is the thing being removed. Arc awaits `bootstrap`, so this costs nothing.
  let cachedRegistry: ReturnType<typeof createCleanupRegistry> | undefined;
  const registry = async (): Promise<ReturnType<typeof createCleanupRegistry>> => {
    cachedRegistry ??= createCleanupRegistry(
      typeof deps.recipes === "function" ? await deps.recipes() : deps.recipes,
    );
    return cachedRegistry;
  };

  // An ARRAY was already materialised by the caller, so validate it NOW and keep the
  // long-standing "duplicate recipe id fails at construction" contract exactly.
  // Deferral is only for the thunk form, where building early is the whole problem —
  // and there the same check still runs at bootstrap, so no deployment boots with a
  // duplicate either way.
  // SYNCHRONOUS on purpose: an array is already materialised, so the id-uniqueness
  // check must still throw from the constructor, exactly as it always has. Routing it
  // through the async accessor would downgrade that throw to an unhandled rejection.
  if (typeof deps.recipes !== "function") cachedRegistry = createCleanupRegistry(deps.recipes);

  let cached: CleanupService | undefined;
  const service = async (): Promise<CleanupService> => {
    if (cached) return cached;
    cached = createCleanupService({
      registry: await registry(),
      // Resolved HERE — inside `service()`, which first runs at bootstrap. A
      // thunk-supplied store therefore registers its model inside arc's
      // lifecycle instead of ahead of it.
      runStore: await resolve(deps.runStore),
      evidenceStore: await resolve(deps.evidenceStore),
      writeFence: await resolve(deps.writeFence),
      jobQueue: await resolve(deps.jobQueue),
      limits: deps.limits,
      leaseMs: deps.leaseMs,
      progressThrottleMs: deps.progressThrottleMs,
      generateId: deps.generateId,
      now: deps.now,
    });
    return cached;
  };
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
          return reply.send({ recipes: (await registry()).introspect() });
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
          const body = req.body as {
            recipe: string;
            parameters?: Record<string, unknown>;
            excludeSteps?: string[];
          };
          const plan = await (await service()).preview({
            recipeId: body.recipe,
            parameters: body.parameters,
            excludeSteps: body.excludeSteps,
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
            excludeSteps?: string[];
            planDigest: string;
            reason: string;
            confirmation?: string;
          };
          const run = await (await service()).execute({
            recipeId: body.recipe,
            parameters: body.parameters,
            excludeSteps: body.excludeSteps,
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
          return reply.send(await (await service()).getRun(id));
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
            return reply.send(await (await service()).cancel(id, { actor: actionActor, reason }));
          }
          return reply.send(await (await service()).retry(id));
        },
      },
    ],
  });

  return defineModule<CleanupService>({
    name: deps.moduleName ?? "data-cleanup",
    ...(deps.owns ? { owns: deps.owns } : {}),
    bootstrap: () => service(),
    resources: () => [resource],
  });
}
