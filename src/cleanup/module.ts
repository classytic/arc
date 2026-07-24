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
 *   POST {prefix}/runs            — execute a confirmed plan       [execute]
 *   GET  {prefix}/runs/:id        — observe a run                  [view]
 *   POST {prefix}/runs/:id/action — cancel | retry                 [manage]
 *
 * The resource has NO Mongo model — run/evidence persistence is the injected
 * ports' job (the host owns the collections). Routes are `raw` Fastify handlers
 * with route-level `permissions`; thrown `CleanupError`s carry `status`/`code`
 * so arc's error handler maps them without a per-host mapper.
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
import { createCleanupService, type CleanupService } from "./service.js";
import type {
  CleanupEvidenceStore,
  CleanupPermissions,
  CleanupRecipe,
  CleanupRunStore,
  CleanupWorker,
  CleanupWriteFence,
  PurgeActor,
} from "./types.js";

export interface DataCleanupModuleDeps {
  /** The recipes this deployment exposes. Ids must be unique (boot-checked). */
  recipes: readonly CleanupRecipe[];
  /** Durable run store — host-owned persistence. */
  runStore: CleanupRunStore;
  /** Durable evidence + manifest store — host-owned persistence. */
  evidenceStore: CleanupEvidenceStore;
  /** Permission checks for view / execute / manage. */
  permissions: CleanupPermissions;
  /** Optional write fence (§8). */
  writeFence?: CleanupWriteFence | undefined;
  /** Optional worker (§8) — defaults to inline in-process. */
  worker?: CleanupWorker | undefined;
  /** Route prefix. Default `/governance/data-cleanup`. */
  prefix?: string | undefined;
  /** Module name. Default `data-cleanup`. */
  moduleName?: string | undefined;
  /** App resource names this module supersedes. */
  owns?: readonly string[] | undefined;
  /**
   * Derive the acting party from the request. Default reads
   * `getUserId(req.scope)` → `{ ref: 'user:<id>', kind: 'user' }`, falling back
   * to `{ ref: 'user:unknown', kind: 'user' }`.
   */
  resolveActor?: (req: RequestWithExtras) => PurgeActor;
  /** Injected id generator (tests). Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** Injected clock (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
}

function defaultResolveActor(req: RequestWithExtras): PurgeActor {
  const id = (req.scope ? getUserId(req.scope) : undefined) ?? (req.user as { id?: string } | undefined)?.id;
  return { ref: id ? `user:${id}` : "user:unknown", kind: "user" };
}

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
    worker: deps.worker,
    generateId: deps.generateId,
    now: deps.now,
  });
  const prefix = deps.prefix ?? "/governance/data-cleanup";
  const resolveActor = deps.resolveActor ?? defaultResolveActor;
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
        raw: true,
        handler: async (_req: FastifyRequest, reply: FastifyReply) => {
          return reply.send({ recipes: registry.introspect() });
        },
      },
      {
        method: "POST",
        path: "/preview",
        summary: "Preview a cleanup plan (no mutation)",
        permissions: view,
        raw: true,
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const r = req as RequestWithExtras;
          const body = (req.body ?? {}) as { recipe?: string; parameters?: Record<string, unknown> };
          if (!body.recipe) throw CleanupErrors.unknownRecipe(String(body.recipe));
          const plan = await service.preview({
            recipeId: body.recipe,
            parameters: body.parameters,
            actor: resolveActor(r),
          });
          return reply.send(plan);
        },
      },
      {
        method: "POST",
        path: "/runs",
        summary: "Execute a confirmed cleanup plan",
        permissions: execute,
        raw: true,
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const r = req as RequestWithExtras;
          const body = (req.body ?? {}) as {
            recipe?: string;
            parameters?: Record<string, unknown>;
            planDigest?: string;
            reason?: string;
            confirmation?: string;
          };
          if (!body.recipe) throw CleanupErrors.unknownRecipe(String(body.recipe));
          const run = await service.execute({
            recipeId: body.recipe,
            parameters: body.parameters,
            planDigest: String(body.planDigest ?? ""),
            reason: String(body.reason ?? ""),
            confirmation: body.confirmation,
            actor: resolveActor(r),
          });
          return reply.status(202).send(run);
        },
      },
      {
        method: "GET",
        path: "/runs/:id",
        summary: "Observe a cleanup run",
        permissions: view,
        raw: true,
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          return reply.send(await service.getRun(id));
        },
      },
      {
        method: "POST",
        path: "/runs/:id/action",
        summary: "Cancel or retry a cleanup run",
        permissions: manage,
        raw: true,
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const { action } = (req.body ?? {}) as { action?: string };
          if (action === "cancel") return reply.send(await service.cancel(id));
          if (action === "retry") return reply.send(await service.retry(id));
          throw CleanupErrors.invalidAction(String(action), "unknown");
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
