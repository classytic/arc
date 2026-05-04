/**
 * Audit Plugin
 *
 * Optional audit trail. Disabled by default — enable explicitly.
 *
 * @example
 * ```ts
 * import { auditPlugin } from '@classytic/arc/audit';
 *
 * // Development: in-memory default (no options needed)
 * await fastify.register(auditPlugin, { enabled: true });
 *
 * // Production: pass any RepositoryLike — mongokit / prismakit / custom
 * import { Repository } from '@classytic/mongokit';
 * await fastify.register(auditPlugin, {
 *   enabled: true,
 *   repository: new Repository(AuditEntryModel),
 * });
 * ```
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { RequestContext, UserBase } from "../types/index.js";
import { repositoryAsAuditStore } from "./repository-audit-adapter.js";
import type { AuditContext, AuditEntry, AuditStore } from "./stores/interface.js";
import { createAuditEntry } from "./stores/interface.js";
import { MemoryAuditStore } from "./stores/memory.js";

export interface AuditPluginOptions {
  /** Enable audit logging (default: false) */
  enabled?: boolean;
  /**
   * Repository managing the audit collection. Arc consumes it **directly**
   * — no wrapping, no aliases, no proxy classes. Pass any object that
   * implements arc's `RepositoryLike` (mongokit's `Repository`, prismakit's
   * repo, a custom implementation). Arc calls `repository.create(entry)` to
   * log and `repository.findAll(filter, options)` to query.
   *
   * If neither `repository` nor `customStores` is provided, falls back to
   * `MemoryAuditStore` (intended for dev / tests only).
   */
  repository?: RepositoryLike;
  /**
   * Custom audit stores — for backends that aren't repositories (Kafka, S3,
   * OpenTelemetry exporter, etc.). Each must implement the `AuditStore`
   * interface. `repository` and `customStores` compose: entries get logged
   * to every store.
   */
  customStores?: AuditStore[];
  /**
   * Retention policy — optional. Entries older than `maxAgeMs` are purged
   * on a timer (`purgeIntervalMs`, default 24h). Stores that implement
   * `purgeOlderThan` participate; append-only stores are skipped.
   *
   * Apps on MongoDB can instead declare a TTL index on the audit
   * collection's `timestamp` field — server-side TTL is cheaper than a
   * periodic delete. Both approaches coexist: `fastify.audit.purge(...)`
   * is always available for manual / cron-driven purges.
   *
   * Set `purgeIntervalMs: 0` to skip the timer (manual purge only).
   */
  retention?: {
    /** Max entry age in ms. Entries with `timestamp < now - maxAgeMs` are purged. */
    maxAgeMs: number;
    /** Interval between purges in ms. Default 86_400_000 (24h). 0 disables the timer. */
    purgeIntervalMs?: number;
  };
  /**
   * Automatically audit CRUD operations via the hook system (default: true when enabled).
   * When enabled, create/update/delete operations are auto-logged without manual calls.
   *
   * **Three opt-in patterns** — pick the one that matches your app:
   *
   * 1. **Per-resource opt-in (recommended for most apps)** — set `audit: true` on each
   *    resource. Audit only fires for those resources. No global `include`/`exclude` needed.
   *    ```ts
   *    defineResource({ name: 'order', audit: true });
   *    // auditPlugin auto-detects which resources opted in
   *    ```
   *
   * 2. **Allowlist mode** — set `include: ['order', 'invoice']` for centralized config.
   *    Only listed resources are audited.
   *
   * 3. **Denylist mode** — set `exclude: ['health', 'metrics']` to audit everything except
   *    listed resources. Use sparingly — leads to growing exclude lists.
   *
   * Default behavior (`autoAudit: true`): denylist mode with no exclusions (audit everything).
   * For most apps, switching to per-resource opt-in is cleaner.
   *
   * - `true`: Audit all CRUD operations on all resources (legacy default)
   * - `{ operations: ['create', 'delete'] }`: Only specific operations
   * - `{ include: ['order'] }`: Allowlist — only listed resources
   * - `{ exclude: ['health'] }`: Denylist — all except listed
   * - `{ perResource: true }`: Only resources with `audit: true` in their definition
   * - `false`: Disable auto-audit (manual `fastify.audit.*()` calls only)
   */
  autoAudit?:
    | boolean
    | {
        operations?: ("create" | "update" | "delete")[];
        /** Allowlist — only listed resources are audited (mutually exclusive with exclude) */
        include?: string[];
        /** Denylist — audit everything except listed resources */
        exclude?: string[];
        /**
         * Per-resource opt-in mode: only audit resources with `audit: true` in their
         * `defineResource()` config. The cleanest pattern for most apps.
         */
        perResource?: boolean;
      };
}

declare module "fastify" {
  interface FastifyInstance {
    /** Log an audit entry */
    audit: AuditLogger;
  }

  interface FastifyRequest {
    /** Audit context for current request */
    auditContext?: AuditContext;
  }
}

export interface AuditLogger {
  /** Log a create action */
  create: (
    resource: string,
    documentId: string,
    data: Record<string, unknown>,
    context?: AuditContext,
  ) => Promise<void>;

  /** Log an update action */
  update: (
    resource: string,
    documentId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    context?: AuditContext,
  ) => Promise<void>;

  /** Log a delete action */
  delete: (
    resource: string,
    documentId: string,
    data: Record<string, unknown>,
    context?: AuditContext,
  ) => Promise<void>;

  /** Log a restore action (soft delete undo) */
  restore: (
    resource: string,
    documentId: string,
    data: Record<string, unknown>,
    context?: AuditContext,
  ) => Promise<void>;

  /** Log a custom action */
  custom: (
    resource: string,
    documentId: string,
    action: string,
    data?: Record<string, unknown>,
    context?: AuditContext,
  ) => Promise<void>;

  /** Query audit logs (if stores support it) */
  query: (options: import("./stores/interface.js").AuditQueryOptions) => Promise<AuditEntry[]>;

  /**
   * Purge audit entries older than `cutoff` across every registered store.
   * Returns the total number of entries deleted. Stores that don't support
   * deletion (append-only emitters) are skipped silently.
   */
  purge: (cutoff: Date) => Promise<number>;
}

const auditPlugin: FastifyPluginAsync<AuditPluginOptions> = async (
  fastify: FastifyInstance,
  opts: AuditPluginOptions = {},
) => {
  const { enabled = false, repository, customStores = [] } = opts;

  // Skip if not enabled
  if (!enabled) {
    // Provide no-op audit methods
    fastify.decorate("audit", createNoopLogger());
    fastify.decorateRequest("auditContext", undefined);
    fastify.log?.debug?.("Audit plugin disabled");
    return;
  }

  // Assemble stores. When `repository` is passed, we consume it directly —
  // no adapter class, no indirection. `repositoryAsStore` below is an inline
  // closure that maps AuditStore vocabulary to RepositoryLike calls. Custom
  // stores (Kafka, S3, etc.) compose alongside; memory is the final fallback
  // for dev / tests.
  const stores: AuditStore[] = [];
  if (repository) stores.push(repositoryAsAuditStore(repository));
  stores.push(...customStores);
  if (stores.length === 0) stores.push(new MemoryAuditStore());

  // Log to all stores
  async function logToStores(entry: AuditEntry): Promise<void> {
    await Promise.all(stores.map((store) => store.log(entry)));
  }

  // Create audit logger
  const audit: AuditLogger = {
    async create(resource, documentId, data, context) {
      const entry = createAuditEntry(resource, documentId, "create", context ?? {}, {
        after: data,
      });
      await logToStores(entry);
    },

    async update(resource, documentId, before, after, context) {
      const entry = createAuditEntry(resource, documentId, "update", context ?? {}, {
        before,
        after,
      });
      await logToStores(entry);
    },

    async delete(resource, documentId, data, context) {
      const entry = createAuditEntry(resource, documentId, "delete", context ?? {}, {
        before: data,
      });
      await logToStores(entry);
    },

    async restore(resource, documentId, data, context) {
      const entry = createAuditEntry(resource, documentId, "restore", context ?? {}, {
        after: data,
      });
      await logToStores(entry);
    },

    async custom(resource, documentId, action, data, context) {
      const entry = createAuditEntry(resource, documentId, "custom", context ?? {}, {
        metadata: { customAction: action, ...data },
      });
      await logToStores(entry);
    },

    async query(options) {
      // Use first store that supports querying
      for (const store of stores) {
        if (store.query) {
          return store.query(options);
        }
      }
      return [];
    },

    async purge(cutoff) {
      // Fan out across every store that supports deletion. Append-only
      // stores (Kafka/S3 emitters without purgeOlderThan) are skipped.
      let total = 0;
      for (const store of stores) {
        if (store.purgeOlderThan) {
          total += await store.purgeOlderThan(cutoff);
        }
      }
      return total;
    },
  };

  fastify.decorate("audit", audit);

  // Extract audit context from request
  fastify.decorateRequest("auditContext", undefined);

  fastify.addHook("onRequest", async (request) => {
    const user = (request as FastifyRequest & { user?: UserBase }).user;
    const _context = (request as FastifyRequest & { context?: RequestContext }).context;

    // Derive org ID from request.scope (set by auth adapters)
    const scope = request.scope;
    const auditOrgId =
      scope?.kind === "member"
        ? scope.organizationId
        : scope?.kind === "elevated"
          ? scope.organizationId
          : undefined;

    request.auditContext = {
      user,
      organizationId: auditOrgId,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      endpoint: undefined,
      duration: undefined,
    };
  });

  // Populate endpoint and duration after response is sent
  fastify.addHook("onResponse", async (request, reply) => {
    if (request.auditContext) {
      request.auditContext.endpoint = `${request.method} ${request.routeOptions?.url ?? request.url}`;
      request.auditContext.duration = Math.round(reply.elapsedTime);
    }
  });

  // Retention — periodic auto-purge. `purgeIntervalMs: 0` disables the
  // timer; manual `fastify.audit.purge(...)` still works.
  const retention = opts.retention;
  let retentionTimer: NodeJS.Timeout | null = null;
  if (retention) {
    const interval = retention.purgeIntervalMs ?? 86_400_000;
    if (interval > 0) {
      retentionTimer = setInterval(() => {
        const cutoff = new Date(Date.now() - retention.maxAgeMs);
        audit.purge(cutoff).catch((err) => {
          fastify.log?.warn?.({ err }, "audit retention purge failed");
        });
      }, interval);
      // Don't keep the event loop alive just for this.
      retentionTimer.unref?.();
    }
  }

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    if (retentionTimer) clearInterval(retentionTimer);
    await Promise.all(stores.map((store) => store.close?.()));
  });

  // Auto-audit CRUD operations via hook system
  const autoAuditConfig = opts.autoAudit ?? true;
  if (autoAuditConfig !== false) {
    const defaultOps = ["create", "update", "delete"] as const;
    const isObj = typeof autoAuditConfig === "object";
    const ops = isObj ? (autoAuditConfig.operations ?? defaultOps) : defaultOps;
    const includeResources =
      isObj && autoAuditConfig.include ? new Set(autoAuditConfig.include) : null;
    const excludeResources = new Set(isObj ? (autoAuditConfig.exclude ?? []) : []);
    const perResourceMode = isObj ? autoAuditConfig.perResource === true : false;

    // Validate mutually exclusive options
    if (includeResources && excludeResources.size > 0) {
      fastify.log?.warn?.(
        "Audit autoAudit: both 'include' and 'exclude' specified. Using 'include' (allowlist wins).",
      );
    }

    // Wire hooks after all plugins are registered (onReady) so arc-core is available
    fastify.addHook("onReady", async () => {
      // fastify.arc is declared via module augmentation in arcCorePlugin.ts
      const arc = "arc" in fastify ? fastify.arc : undefined;
      if (!arc?.hooks) {
        fastify.log?.debug?.("Auto-audit skipped: arc-core plugin not registered");
        return;
      }

      // Build the set of opted-in resources for per-resource mode.
      // Read from the resource registry — resources with `audit: true` in defineResource.
      const optedInResources = new Set<string>();
      const operationsByResource = new Map<string, ReadonlyArray<"create" | "update" | "delete">>();
      if (perResourceMode && arc.registry) {
        for (const entry of arc.registry.getAll()) {
          const auditFlag = entry.audit;
          if (!auditFlag) continue;
          optedInResources.add(entry.name);
          // Per-resource operation override (e.g., audit: { operations: ['delete'] })
          if (typeof auditFlag === "object" && auditFlag.operations) {
            operationsByResource.set(entry.name, auditFlag.operations);
          }
        }
      }

      for (const op of ops) {
        arc.hooks.after(
          "*",
          op,
          async (ctx) => {
            // Filter by mode (priority: perResource > include > exclude)
            if (perResourceMode) {
              if (!optedInResources.has(ctx.resource)) return;
              // Per-resource operations override
              const allowedOps = operationsByResource.get(ctx.resource);
              if (allowedOps && !allowedOps.includes(op)) return;
            } else if (includeResources) {
              if (!includeResources.has(ctx.resource)) return;
            } else if (excludeResources.has(ctx.resource)) {
              return;
            }

            const docId = autoAuditExtractId(ctx.result);
            const scope = (ctx.context as Record<string, unknown> | undefined)?._scope;
            const auditCtx: AuditContext = {
              user: ctx.user,
              organizationId: scope ? autoAuditGetOrgId(scope) : undefined,
            };

            try {
              if (op === "create") {
                await audit.create(ctx.resource, docId, autoAuditToPlain(ctx.result), auditCtx);
              } else if (op === "update") {
                await audit.update(
                  ctx.resource,
                  docId,
                  autoAuditToPlain(ctx.meta?.existing),
                  autoAuditToPlain(ctx.result),
                  auditCtx,
                );
              } else if (op === "delete") {
                await audit.delete(ctx.resource, docId, autoAuditToPlain(ctx.result), auditCtx);
              }
            } catch (err) {
              fastify.log?.warn?.({ resource: ctx.resource, op, err }, "Auto-audit failed");
            }
          },
          90,
        ); // Priority 90 — after user hooks, before event hooks at 100
      }

      fastify.log?.debug?.({ ops, exclude: [...excludeResources] }, "Auto-audit hooks registered");
    });
  }

  fastify.log?.debug?.({ stores: stores.map((s) => s.name) }, "Audit plugin enabled");
};

/** Extract document ID from a result */
function autoAuditExtractId(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const d = doc as Record<string, unknown>;
  const rawId = d._id ?? d.id;
  return rawId != null ? String(rawId) : "";
}

/** Convert Mongoose doc or plain object to plain object */
function autoAuditToPlain(doc: unknown): Record<string, unknown> {
  if (!doc || typeof doc !== "object") return {};
  if (typeof (doc as Record<string, unknown>).toObject === "function") {
    return (doc as { toObject: () => Record<string, unknown> }).toObject();
  }
  return doc as Record<string, unknown>;
}

/** Extract org ID from scope (avoids importing scope module to prevent circular deps) */
function autoAuditGetOrgId(scope: unknown): string | undefined {
  if (!scope || typeof scope !== "object") return undefined;
  const s = scope as Record<string, unknown>;
  if (s.kind === "member" || s.kind === "elevated") {
    return s.organizationId as string | undefined;
  }
  return undefined;
}

/**
 * Create no-op logger for when audit is disabled
 */
function createNoopLogger(): AuditLogger {
  const noop = async () => {};
  return {
    create: noop,
    update: noop,
    delete: noop,
    restore: noop,
    custom: noop,
    query: async () => [],
    purge: async () => 0,
  };
}

export default fp(auditPlugin, {
  name: "arc-audit",
  fastify: "5.x",
  dependencies: ["arc-core"],
});

export { auditPlugin };
