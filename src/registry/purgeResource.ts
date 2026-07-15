/**
 * Per-resource purge helper — bridges arc's resolved strategy to the
 * kit's `purgeByField` primitive (or falls back to legacy `deleteMany`
 * for adapters that haven't been upgraded).
 *
 * Lives in its own file so the cascade runner stays focused on
 * orchestration (filter → sort by priority → loop) and this file owns
 * the per-resource decision tree (purgeByField? deleteMany? skip?).
 */

import type {
  TenantPurgeOptions,
  TenantPurgeProgress,
  TenantPurgeResult,
  TenantPurgeStrategy,
} from "@classytic/repo-core/repository";
import type { ResolvedTenantPurge } from "../types/resource/index.js";

/**
 * Capability sniffing on the adapter repository. Listed in priority order:
 *
 *   - `purgeByField(field, value, strategy, options)` — preferred. Chunked,
 *     plugin-composed, progress + abort. Every repo-core 0.x+ kit ships it.
 *   - `deleteMany(filter)` — legacy fallback. Single round-trip, no
 *     chunking, hard delete only. Used only when the strategy is `hard`
 *     AND `purgeByField` is missing.
 */
interface PurgeCapableRepo {
  purgeByField?: (
    field: string,
    value: unknown,
    strategy: TenantPurgeStrategy,
    options?: TenantPurgeOptions,
  ) => Promise<TenantPurgeResult>;
  deleteMany?: (filter: Record<string, unknown>) => Promise<unknown>;
  deleteByFilter?: (filter: Record<string, unknown>) => Promise<unknown>;
  removeMany?: (filter: Record<string, unknown>) => Promise<unknown>;
}

export interface PurgeResourceOptions {
  /** Forwarded to `purgeByField` — chunk-level progress. */
  onProgress?: (event: TenantPurgeProgress) => void | Promise<void>;
  /** Forwarded to `purgeByField` — abort between chunks. */
  signal?: AbortSignal;
  /** Forwarded to `purgeByField` — override per-resource batchSize. */
  batchSize?: number;
}

/**
 * Outcome for one resource. Wider than `TenantPurgeResult` because it
 * carries the resource name + tenantField for the aggregate report,
 * and a `path` discriminator so audit consumers can tell which code
 * path ran.
 */
export interface PurgeResourceOutcome {
  readonly resource: string;
  readonly tenantField: string;
  /**
   * Full `TenantPurgeStrategy` discriminated union. Audit consumers
   * narrow on `.strategy.type` for typed access — `skip` carries the
   * mandatory `reason`, `anonymize` carries the field map, `custom`
   * carries the handler descriptor. Pre-2.17 this was the `.type` tag
   * only, which dropped the audit-critical `reason` field.
   */
  readonly strategy: TenantPurgeStrategy;
  readonly processed: number;
  readonly ok: boolean;
  readonly path: "purgeByField" | "legacy-deleteMany" | "skipped" | "unsupported";
  readonly skipReason?: string;
  readonly error?: { code?: string; message: string };
  readonly durationMs?: number;
}

/**
 * Run the resolved strategy against one resource's repository.
 *
 * - `skip` strategy: returns `path: 'skipped'` without touching the repo.
 * - `purgeByField` present: routes through it (chunked, progress, abort).
 * - `purgeByField` absent + hard strategy: legacy `deleteMany` fallback.
 * - `purgeByField` absent + non-hard strategy: returns `path: 'unsupported'`
 *   with a clear error — soft/anonymize require the new primitive.
 */
export async function purgeResource(
  resourceName: string,
  tenantField: string,
  organizationId: string,
  resolved: ResolvedTenantPurge,
  repo: PurgeCapableRepo,
  options: PurgeResourceOptions = {},
): Promise<PurgeResourceOutcome> {
  const { strategy } = resolved;

  // Skip — declared no-op. No I/O, surface the reason.
  if (strategy.type === "skip") {
    return {
      resource: resourceName,
      tenantField,
      strategy,
      processed: 0,
      ok: true,
      path: "skipped",
      skipReason: strategy.reason,
    };
  }

  // Preferred path: `purgeByField` (chunked, plugin-composed).
  if (typeof repo.purgeByField === "function") {
    const result = await repo.purgeByField(tenantField, organizationId, strategy, {
      batchSize: options.batchSize ?? resolved.batchSize,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    return {
      resource: resourceName,
      tenantField,
      // Repo-core's `TenantPurgeResult.strategy` is the discriminant tag
      // only — the full strategy (with `reason` / `fields` / handler
      // descriptor) lives on the input we still have in scope. Surface
      // that so audit consumers don't have to re-resolve from the
      // resource definition.
      strategy,
      processed: result.processed,
      ok: result.ok,
      path: "purgeByField",
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  // Legacy fallback — only valid for `hard` strategy. Soft/anonymize
  // need `purgeByField` (the legacy adapter has no way to express them).
  if (strategy.type !== "hard") {
    return {
      resource: resourceName,
      tenantField,
      strategy,
      processed: 0,
      ok: false,
      path: "unsupported",
      error: {
        code: "arc.purge.unsupported_strategy",
        message:
          `Resource '${resourceName}' uses strategy '${strategy.type}' but its adapter ` +
          "repository does not implement `purgeByField`. Upgrade the adapter (@classytic/" +
          "mongokit ≥ 3.13.4 / @classytic/sqlitekit ≥ 0.3.4) or change the strategy to 'hard'.",
      },
    };
  }

  const op = repo.deleteMany ?? repo.deleteByFilter ?? repo.removeMany;
  if (!op) {
    return {
      resource: resourceName,
      tenantField,
      strategy,
      processed: 0,
      ok: false,
      path: "unsupported",
      error: {
        code: "arc.purge.no_bulk_op",
        message:
          `Resource '${resourceName}' adapter exposes neither \`purgeByField\` nor ` +
          "`deleteMany` / `deleteByFilter` / `removeMany` — bulk cleanup is not supported.",
      },
    };
  }

  try {
    const start = Date.now();
    const result = (await op.call(repo, { [tenantField]: organizationId })) as
      | number
      | { deletedCount?: number; count?: number }
      | undefined;
    const processed =
      typeof result === "number"
        ? result
        : typeof result?.deletedCount === "number"
          ? result.deletedCount
          : typeof result?.count === "number"
            ? result.count
            : -1;
    return {
      resource: resourceName,
      tenantField,
      strategy,
      processed,
      ok: true,
      path: "legacy-deleteMany",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      resource: resourceName,
      tenantField,
      strategy,
      processed: 0,
      ok: false,
      path: "legacy-deleteMany",
      error: {
        code: (err as { code?: string })?.code,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
