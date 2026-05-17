/**
 * Cascade-on-org-delete — compliance-grade tenant cleanup.
 *
 * Multi-tenant hosts on arc declare a per-resource cleanup strategy via
 * `onTenantDelete: { strategy: … }`. When an organization is deleted,
 * the host wires this runner into the auth lifecycle; arc walks the
 * registry, sorts cascading resources by priority, and runs each
 * resource's resolved strategy via the kit's `purgeByField` primitive
 * (chunked, plugin-composed, abort-aware).
 *
 * Strategies cover the compliance matrix: `hard` for GDPR right-to-
 * be-forgotten, `soft` for recoverable windows, `anonymize` for legal-
 * retained records (SOX, HIPAA, PCI), `skip` for system tables. See
 * `OnTenantDeleteConfig` for the full surface.
 *
 * **Failure semantics:** the helper continues on per-resource error and
 * returns a full report including failures. The host decides whether a
 * partial cascade is a hard failure (re-throw) or a degraded mode (log
 * + alert). Returning a structured report instead of throwing keeps the
 * primitive composable — a cron-driven audit and a transactional auth
 * flow have different "what's bad enough to abort" thresholds.
 *
 * @example Better Auth wiring.
 * ```ts
 * import { cascadeDeleteForOrganization } from '@classytic/arc/registry';
 *
 * betterAuth.afterDeleteOrganization = async ({ organizationId }) => {
 *   const report = await cascadeDeleteForOrganization(fastify.arc.registry, {
 *     organizationId,
 *     concurrency: 4,
 *     logger: fastify.log,
 *   });
 *   if (report.failures.length > 0) throw new Error('cascade partial');
 * };
 * ```
 */

import type { TenantPurgeProgress, TenantPurgeStrategy } from "@classytic/repo-core/repository";
import { DEFAULT_TENANT_FIELD } from "../constants.js";
import type { ResolvedTenantPurge } from "../types/resource.js";
import { type PurgeResourceOutcome, purgeResource } from "./purgeResource.js";
import type { ResourceRegistry } from "./ResourceRegistry.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Per-resource result row. One entry for every resource Arc attempted to
 * cascade-delete for the given org. `deletedCount: -1` means the adapter
 * doesn't surface a row count (the delete still ran).
 */
export interface CascadeResourceReport {
  readonly resource: string;
  readonly tenantField: string;
  /**
   * Rows processed. For `hard` strategy this equals rows that no longer
   * exist; for `soft`/`anonymize` it's rows touched (still present).
   * `-1` only on legacy `deleteMany` adapters that don't surface a count.
   */
  readonly deletedCount: number;
  /**
   * Strategy that actually ran for this resource — `'hard'` / `'soft'` /
   * `'anonymize'` / `'skip'`. Audit consumers branch on this to answer
   * "did data physically leave the system?".
   */
  readonly strategy?: TenantPurgeStrategy["type"];
  /**
   * Where the strategy came from — `'declared'` (host wrote
   * `onTenantDelete`) or `'disabled'` (filtered out before reaching
   * this report). Future sources may be added; treat the field as a
   * read-only audit signal.
   */
  readonly strategySource?: ResolvedTenantPurge["source"];
  /**
   * Code path that executed — `'purgeByField'` (preferred, chunked),
   * `'legacy-deleteMany'` (single-shot fallback for old adapters),
   * `'skipped'` (skip strategy), `'unsupported'` (adapter can't run
   * the declared strategy — surfaces in `failures`).
   */
  readonly path?: PurgeResourceOutcome["path"];
  /** Echoed for `skip` strategy — the declared reason. */
  readonly skipReason?: string;
  readonly error?: { code?: string; message: string };
}

/** Aggregate report — splits successful and failed resources for the caller. */
export interface CascadeReport {
  readonly organizationId: string;
  readonly resources: readonly CascadeResourceReport[];
  readonly successes: readonly CascadeResourceReport[];
  readonly failures: readonly CascadeResourceReport[];
  readonly totalDeleted: number;
  readonly durationMs: number;
}

/** Lightweight logger shape — `fastify.log`, `pino`, or `console` all fit. */
interface CascadeLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface CascadeOptions {
  /** Organization id whose tenant-scoped rows should be deleted. */
  readonly organizationId: string;
  /**
   * Skip these resources even if they declare `onTenantDelete`.
   * Useful for stage-gated rollouts ("cascade everything except `audit_log`
   * — we want to keep the trail").
   */
  readonly skip?: readonly string[];
  /**
   * Resource names to LIMIT cascade to. When set, only these resources
   * cascade — useful for partial-cleanup scripts and the test path that
   * verifies one resource at a time.
   */
  readonly only?: readonly string[];
  /** Optional logger — info on each resource, warn/error on failures. */
  readonly logger?: CascadeLogger;
  /**
   * Forwarded to each resource's `purgeByField` — emits per-chunk
   * progress. The event includes the resource name so a single
   * progress handler can drive a multi-resource progress UI.
   */
  readonly onProgress?: (event: TenantPurgeProgress & { resource: string }) => void | Promise<void>;
  /**
   * Forwarded to each resource's `purgeByField`. The runner checks
   * between resources too — aborting mid-cascade stops the next
   * resource from starting, in addition to stopping the currently-
   * running purge between chunks.
   */
  readonly signal?: AbortSignal;
  /**
   * Global override for per-resource batchSize. Per-resource declarations
   * (`onTenantDelete.batchSize`) win when set; this is the fallback.
   */
  readonly batchSize?: number;
  /**
   * Run up to `concurrency` resources in parallel. **Priority groups
   * remain barriers** — all priority-10 resources finish before any
   * priority-50 resource starts. Within a priority, resources run
   * concurrently up to this cap. Default `1` (sequential, safest).
   *
   * Resources are independent (different collections / tables, no
   * cross-resource constraints), so parallelism is safe — but oplog
   * pressure / connection-pool exhaustion / replication lag scale with
   * concurrency. Tune per environment; `4` is usually fine for cloud
   * Mongo + small connection pools, `8`–`16` for high-throughput tiers.
   */
  readonly concurrency?: number;
  /**
   * Cascade-level checkpoint — survive a crash mid-cascade and resume
   * from the last completed resource. `read()` returns the last cascade
   * state (or `undefined` for a fresh run); `write()` persists state
   * after each resource completes. Hosts plumb to Redis / a status
   * table / a dedicated checkpoint store.
   *
   * Per-purge checkpointing is intentionally NOT offered — the chunked
   * primitive is already idempotent (re-running a partially-completed
   * cascade is safe because already-deleted rows don't match the next
   * SELECT). The cascade-level checkpoint just skips entire resources
   * known-completed in the prior pass — wasteful round-trips, not
   * wasteful writes.
   */
  readonly checkpoint?: CascadeCheckpoint;
}

/** Cascade resume state. Persist between runs; rehydrate on retry. */
export interface CascadeCheckpointState {
  /** Names of resources fully completed in a prior pass. Skipped on resume. */
  readonly completedResources: readonly string[];
}

export interface CascadeCheckpoint {
  /** Load the prior cascade state for this org. Return `undefined` for a fresh run. */
  read(): Promise<CascadeCheckpointState | undefined>;
  /** Persist updated state after a resource finishes. */
  write(state: CascadeCheckpointState): Promise<void>;
}

/**
 * Names of resources flagged for cascade — used by audit scripts.
 * A resource is cascading when its resolved strategy isn't `disabled`
 * (i.e. the host declared `onTenantDelete`).
 */
export function getCascadingResources(registry: ResourceRegistry): readonly string[] {
  return registry
    .getAll()
    .filter((r) => isResourceCascading(r))
    .map((r) => r.name);
}

/**
 * Rich introspection — returns the resolved strategy + source per
 * cascading resource. Use for audit dashboards that answer "what
 * happens to this resource on org-delete?" without grepping the
 * source.
 */
export function getCascadingResourcesWithMetadata(registry: ResourceRegistry): readonly {
  name: string;
  tenantField: string;
  strategy: TenantPurgeStrategy["type"];
  source: ResolvedTenantPurge["source"];
  priority: number;
}[] {
  return registry
    .getAll()
    .filter((r) => isResourceCascading(r))
    .map((r) => {
      const resolved = r.resolvedTenantPurge;
      const tenantField =
        (typeof r.tenantField === "string" && r.tenantField) || DEFAULT_TENANT_FIELD;
      // `isResourceCascading` already filtered out `disabled` sources,
      // but TS doesn't know — narrow defensively with a fallback that
      // can't actually be reached.
      const fallback: ResolvedTenantPurge = {
        strategy: { type: "hard" },
        priority: 100,
        source: "declared",
      };
      const r0 = resolved ?? fallback;
      return {
        name: r.name,
        tenantField,
        strategy: r0.strategy.type,
        source: r0.source,
        priority: r0.priority,
      };
    });
}

/** A resource cascades iff its resolved strategy isn't `disabled`. */
function isResourceCascading(r: { resolvedTenantPurge?: ResolvedTenantPurge }): boolean {
  return r.resolvedTenantPurge ? r.resolvedTenantPurge.source !== "disabled" : false;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Cascade-cleanup every tenant-scoped resource for the given organization.
 * Walks the registry in **ascending priority order** (`onTenantDelete.priority`
 * — leaf data first, references last), runs each resource's resolved
 * strategy via `purgeByField` when available (chunked, progress, abort),
 * and returns a structured report.
 *
 * **Strategy resolution** lives in `resolveTenantPurge.ts` — this runner
 * just reads `resource.resolvedTenantPurge` (computed once at boot).
 *
 * **Per-resource execution** lives in `purgeResource.ts` — preferred
 * path is the kit's `purgeByField` (chunked + plugin-composed); falls
 * back to legacy `deleteMany` only for `hard` strategy on adapters that
 * haven't been upgraded.
 *
 * **Failure semantics**: continues on per-resource error, returns the
 * full report. Hosts decide whether a partial cascade is a hard
 * failure (re-throw) or degraded mode (log + alert).
 *
 * @param registry  The arc resource registry (`fastify.arc.registry`).
 * @param options   Org id + filters + logger + progress + signal.
 */
export async function cascadeDeleteForOrganization(
  registry: ResourceRegistry,
  options: CascadeOptions,
): Promise<CascadeReport> {
  const {
    organizationId,
    skip,
    only,
    logger,
    onProgress,
    signal,
    batchSize,
    concurrency = 1,
    checkpoint,
  } = options;
  if (!organizationId) {
    throw new Error("cascadeDeleteForOrganization: `organizationId` is required");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("cascadeDeleteForOrganization: `concurrency` must be a positive integer");
  }

  const skipSet = skip ? new Set(skip) : undefined;
  const onlySet = only ? new Set(only) : undefined;
  const start = Date.now();

  // Rehydrate the resume set from the checkpoint store (if wired). Any
  // resource named in `completedResources` is skipped on this pass —
  // idempotency makes that safe but wasteful, so we skip it entirely.
  const resumeState = await checkpoint?.read();
  const completedSet = resumeState ? new Set(resumeState.completedResources) : undefined;

  // Resources whose resolved strategy is NOT `disabled`, filtered by
  // skip / only / completed, sorted by priority (lower runs first — leaf
  // data before aggregates).
  const flagged = registry
    .getAll()
    .filter((r) => {
      if (!r.resolvedTenantPurge || r.resolvedTenantPurge.source === "disabled") return false;
      if (skipSet?.has(r.name)) return false;
      if (onlySet && !onlySet.has(r.name)) return false;
      if (completedSet?.has(r.name)) return false;
      return true;
    })
    .sort((a, b) => {
      const pa = a.resolvedTenantPurge?.priority ?? 100;
      const pb = b.resolvedTenantPurge?.priority ?? 100;
      return pa - pb;
    });

  const results: CascadeResourceReport[] = [];
  // Completed resources across this run + prior runs (for the checkpoint).
  const completed: string[] = resumeState ? [...resumeState.completedResources] : [];

  // Group by priority — each group is a barrier. All priority-10
  // resources finish before any priority-50 resource starts. Within a
  // group, run `concurrency` at a time.
  const groups = groupByPriority(flagged);

  for (const group of groups) {
    if (signal?.aborted) break;

    // Each group runs in batches of size `concurrency`. The barrier is
    // implicit — we don't proceed to the next group until every promise
    // in this group settles.
    const groupResults = await runWithConcurrency(group, concurrency, async (r) => {
      // Per-resource abort check — a signal that fires mid-group lets
      // in-flight chunks finish (the purge orchestrator handles that)
      // but stops new resources from starting.
      if (signal?.aborted) {
        return undefined; // sentinel — filtered out below
      }
      return runOneResource(r, registry, organizationId, {
        onProgress,
        signal,
        batchSize,
        logger,
      });
    });

    for (const report of groupResults) {
      if (!report) continue;
      results.push(report);
      if (!report.error) {
        completed.push(report.resource);
        if (checkpoint) {
          await checkpoint.write({ completedResources: [...completed] });
        }
      }
    }
  }

  const successes = results.filter((row) => !row.error);
  const failures = results.filter((row) => row.error);
  const totalDeleted = successes.reduce(
    (sum, r) => sum + (r.deletedCount > 0 ? r.deletedCount : 0),
    0,
  );
  return {
    organizationId,
    resources: results,
    successes,
    failures,
    totalDeleted,
    durationMs: Date.now() - start,
  };
}

// ============================================================================
// Helpers — kept small and named so the main flow reads top-to-bottom
// ============================================================================

/** Process a single registry entry under its resolved strategy. */
async function runOneResource(
  r: ReturnType<ResourceRegistry["getAll"]>[number],
  registry: ResourceRegistry,
  organizationId: string,
  ctx: {
    onProgress?: CascadeOptions["onProgress"];
    signal?: AbortSignal;
    batchSize?: number;
    logger?: CascadeLogger;
  },
): Promise<CascadeResourceReport> {
  const tenantField = (typeof r.tenantField === "string" && r.tenantField) || DEFAULT_TENANT_FIELD;

  const liveAdapter = registry.getAdapter<{
    repository?: Parameters<typeof purgeResource>[4];
  }>(r.name);
  const repo = liveAdapter?.repository;
  if (!repo) {
    const report: CascadeResourceReport = {
      resource: r.name,
      tenantField,
      deletedCount: 0,
      path: "unsupported",
      error: {
        code: "arc.no_adapter",
        message: `Resource '${r.name}' has no adapter repository — cascade skipped`,
      },
    };
    ctx.logger?.warn?.(report, "[Arc/Cascade] resource skipped (no adapter)");
    return report;
  }

  const resourceProgress = ctx.onProgress
    ? (event: TenantPurgeProgress) => ctx.onProgress?.({ ...event, resource: r.name })
    : undefined;

  const outcome = await purgeResource(
    r.name,
    tenantField,
    organizationId,
    r.resolvedTenantPurge ?? {
      strategy: { type: "hard" },
      priority: 100,
      source: "declared",
    },
    repo,
    { onProgress: resourceProgress, signal: ctx.signal, batchSize: ctx.batchSize },
  );

  const report: CascadeResourceReport = {
    resource: outcome.resource,
    tenantField: outcome.tenantField,
    deletedCount: outcome.processed,
    strategy: outcome.strategy,
    strategySource: r.resolvedTenantPurge?.source,
    path: outcome.path,
    ...(outcome.skipReason ? { skipReason: outcome.skipReason } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };

  if (outcome.ok) {
    ctx.logger?.info?.(report, "[Arc/Cascade] resource processed");
  } else {
    ctx.logger?.error?.({ report }, "[Arc/Cascade] resource cascade failed");
  }
  return report;
}

/**
 * Group a priority-sorted list of resources into priority barriers.
 * Each returned sub-array contains resources of identical priority;
 * the outer array preserves ascending order. The cascade runner uses
 * this so all priority-N resources finish before any priority-(N+M)
 * starts — leaf-before-references invariant survives concurrency.
 */
function groupByPriority<T extends { resolvedTenantPurge?: ResolvedTenantPurge }>(
  sorted: readonly T[],
): T[][] {
  if (sorted.length === 0) return [];
  const first = sorted[0];
  if (!first) return [];
  const groups: T[][] = [];
  let current: T[] = [first];
  let currentPriority = first.resolvedTenantPurge?.priority ?? 100;
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    if (!item) continue;
    const p = item.resolvedTenantPurge?.priority ?? 100;
    if (p === currentPriority) {
      current.push(item);
    } else {
      groups.push(current);
      current = [item];
      currentPriority = p;
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Run `fn` over `items` with bounded concurrency. Order of results
 * matches input order. Simpler shape than a worker-pool because the
 * group sizes are small (typically <=12 resources per priority band).
 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (concurrency === 1 || items.length <= 1) {
    const results: R[] = [];
    for (const item of items) results.push(await fn(item));
    return results;
  }
  // Sliding-window concurrency: keep up to `concurrency` promises
  // in flight; pick up the next item as soon as one settles.
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      const item = items[i];
      if (item === undefined) continue; // unreachable — sparse array guard
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
