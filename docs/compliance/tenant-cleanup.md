---
title: Tenant cleanup (org delete)
description: GDPR / SOX / HIPAA-compatible org-delete cascade across every tenant-scoped resource.
---

# Tenant cleanup

When an organization is deleted, every row in every tenant-scoped resource needs the right cleanup behavior — hard delete for GDPR, anonymize for legal-retained ledgers, soft delete for audit windows, explicit skip for system tables. Arc walks the resource registry, applies each resource's declared strategy, and reports back. No per-host `org-cleanup.ts` to maintain.

## The 30-second version

```ts
// 1. Declare per-resource strategy on each multi-tenant resource:
defineResource({
  name: 'invoice',
  tenantField: 'organizationId',
  onTenantDelete: { strategy: { type: 'anonymize', fields: { customerName: '[REDACTED]' } } },
});

// 2. Wire the runner into your auth lifecycle (once):
import { cascadeDeleteForOrganization } from '@classytic/arc/registry';

betterAuth.org.afterDelete = async ({ organizationId }) => {
  const report = await cascadeDeleteForOrganization(fastify.arc.registry, {
    organizationId,
    concurrency: 4,
    logger: fastify.log,
  });
  if (report.failures.length > 0) await alerting.fire({ orgId: organizationId, report });
};
```

That's it. Arc handles discovery, ordering, chunking, plugin composition, abort, retry, checkpoint.

## Strategies

Four variants, each maps to one kit-native primitive:

| Strategy | When | What runs |
|---|---|---|
| `{ type: 'hard' }` | GDPR right-to-be-forgotten | Chunked `deleteMany` — rows physically removed |
| `{ type: 'soft' }` | Recoverable / audit window | Chunked `updateMany` setting `deleted: true` + `deletedAt`. Pair with TTL for eventual hard-purge |
| `{ type: 'anonymize', fields }` | Legal-retained ledgers (SOX, HIPAA, PCI) | Chunked `updateMany`. `fields` is a map of static values OR `(doc) => value` functions for derived patches (hashes, etc.) |
| `{ type: 'skip', reason }` | System tables, cross-tenant rollups | No-op. `reason` is **mandatory** — silent skips are compliance leaks |

### Strategy shape — full

```ts
onTenantDelete: {
  strategy:
    | { type: 'hard' }
    | { type: 'soft'; deletedField?: string; deletedAtField?: string }
    | { type: 'anonymize'; fields: Record<string, unknown | ((doc: TDoc) => unknown)> }
    | { type: 'skip'; reason: string };
  priority?: number;   // lower runs first — default 100
  batchSize?: number;  // chunk size — default 1000
}
```

### When to pick which

- **Hard** is the default for most data. Activity logs, sessions, drafts, anything ephemeral.
- **Soft** when you need an undo window (typical: 30 days) before the data goes. Pair with a TTL index for automatic eventual cleanup.
- **Anonymize** when the row CANNOT leave (financial records under SOX, medical history under HIPAA, transactions under PCI) but must lose PII linkage. The `fields` map names the columns to clear — auditors read it.
- **Skip** when the resource isn't tenant-scoped (platform settings, lookup tables) OR the data outlives orgs by design (cross-tenant audit trail). The `reason` shows up in audit reports.

## Priority — ordering across resources

Lower `priority` runs first. Use to clean leaf data before aggregates:

```ts
// runs in this order:
defineResource({ name: 'event',    onTenantDelete: { strategy: { type: 'hard' }, priority: 10  } }); // leaf
defineResource({ name: 'campaign', onTenantDelete: { strategy: { type: 'hard' }, priority: 50  } }); // entity
defineResource({ name: 'member',   onTenantDelete: { strategy: { type: 'hard' }, priority: 100 } }); // reference
```

Priority groups are **barriers** even under concurrency — all priority-10 resources finish before any priority-50 resource starts.

## Concurrency

Default `1` (sequential, safest). Resources are independent — bump for parallelism within a priority group:

```ts
await cascadeDeleteForOrganization(registry, { organizationId, concurrency: 4 });
```

Tune per environment. `4` is a good fit for cloud Mongo + small connection pools; `8`–`16` for high-throughput tiers. Watch oplog pressure and replication lag.

## Discovery — how arc knows which resources to touch

The cascade walks `fastify.arc.registry.getAll()` and includes any resource whose `resolvedTenantPurge.source === 'declared'`:

- `'declared'` — host wrote `onTenantDelete: { strategy }` → included.
- `'disabled'` — no declaration → skipped (safe default).

Unflagged resources are **never touched**. To include a resource in the cascade you MUST declare an `onTenantDelete` strategy on it.

**Audit-list** — answer "what happens on org delete?" in one call:

```ts
import { getCascadingResourcesWithMetadata } from '@classytic/arc/registry';

const audit = getCascadingResourcesWithMetadata(fastify.arc.registry);
// → [
//   { name: 'invoice',  tenantField: 'organizationId', strategy: 'anonymize', source: 'declared',      priority: 50 },
//   { name: 'campaign', tenantField: 'organizationId', strategy: 'hard',      source: 'inferred-hard', priority: 100 },
// ]
```

Compliance signs off on this list; arc enforces it at runtime.

## Retry — handle transient failures

Opt in per call. Retries at the chunk level — already-committed chunks stay committed.

```ts
await cascadeDeleteForOrganization(registry, {
  organizationId,
  // Forwarded into each resource's purgeByField; can also be set per-resource.
  // Default `undefined` = no retry (first chunk error aborts the resource).
});
```

For richer per-resource retry, pass at the kit level via the repository wrapper. See `TenantPurgeOptions.retry` in `@classytic/repo-core/repository`.

## Checkpoint resume

For cascades that take minutes and might crash mid-run:

```ts
const redis = makeRedis();
const checkpoint = {
  read: async () => {
    const raw = await redis.get(`cascade:${orgId}`);
    return raw ? JSON.parse(raw) : undefined;
  },
  write: async (state) => {
    await redis.setex(`cascade:${orgId}`, 86400, JSON.stringify(state));
  },
};

await cascadeDeleteForOrganization(registry, { organizationId, checkpoint });
```

On crash, re-running picks up from the last completed resource. Per-chunk checkpointing isn't offered — the chunked primitive is already idempotent, so resuming a partially-completed resource is a wasteful (but safe) full re-pass; resource-level skipping is the meaningful win.

## Smoke verification

After the cascade, hosts call `assertNoTenantData` in their compliance suite — walks every cascading resource, asserts zero matching rows (or for anonymize, that the row count didn't change beyond the rewrite):

```ts
import { assertNoTenantData } from '@classytic/arc/registry';

it('after org delete, no tenant data leaks', async () => {
  await seedTestOrg();
  await cascadeDeleteForOrganization(arc.registry, { organizationId: 'test-org' });

  const audit = await assertNoTenantData(arc.registry, { organizationId: 'test-org' });
  expect(audit.ok).toBe(true);
  expect(audit.leaks).toEqual([]);
});
```

Skip strategies surface in `audit.skipped` with their declared reasons; anonymize is skipped from the assertion by default (rows legitimately retained).

## Indexing — non-negotiable on large tenants

Every cascading resource MUST have an index leading with its `tenantField`. Without it, each chunk's selection runs a full collection scan and the cascade becomes O(n²):

- **Mongo**: `Schema.index({ organizationId: 1 })` (or a compound index whose first column is `organizationId`).
- **SQL**: `CREATE INDEX idx_<table>_org ON <table> (organization_id);`.

Verify with `db.coll.getIndexes()` / `EXPLAIN QUERY PLAN`. Tested in `assertNoTenantData` will run fine without it — production with 10M-row tenants will not.

## Failure semantics

`cascadeDeleteForOrganization` returns a `CascadeReport`, never throws for per-resource errors:

```ts
const report = await cascadeDeleteForOrganization(registry, { organizationId });
// {
//   organizationId, resources: [...], successes: [...], failures: [...],
//   totalDeleted, durationMs
// }
```

Hosts decide whether a partial failure is hard (re-throw) or degraded (log + alert). The `report.resources[i].path` discriminator tells you which code path ran:

- `'purgeByField'` — preferred, chunked, plugin-composed
- `'legacy-deleteMany'` — adapter doesn't ship `purgeByField` yet; hard-only fallback
- `'skipped'` — skip strategy
- `'unsupported'` — adapter can't run the declared strategy (`soft`/`anonymize` on a non-mongokit/sqlitekit adapter)

## References

- API: `@classytic/arc/registry` — `cascadeDeleteForOrganization`, `assertNoTenantData`, `getCascadingResourcesWithMetadata`
- Contract: `@classytic/repo-core/repository` — `StandardRepo.purgeByField`, `TenantPurgeStrategy`
- Kit impls: `@classytic/mongokit` 3.14+, `@classytic/sqlitekit` 0.4+
