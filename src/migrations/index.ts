/**
 * Schema Versioning and Migrations System
 *
 * Manages database schema changes over time with version tracking.
 * Supports forward migrations, rollbacks, and schema compatibility layers.
 *
 * DB-agnostic: the `db` parameter is typed as `unknown` — the user passes
 * whatever connection object their adapter uses (Mongoose db, Prisma client,
 * Knex instance, etc.) and their `up`/`down` functions cast it internally.
 *
 * @example
 * import { defineMigration, MigrationRunner } from '@classytic/arc/migrations';
 *
 * const productV2 = defineMigration({
 *   version: 2,
 *   resource: 'product',
 *   up: async (db) => {
 *     const mongo = db as import('mongoose').mongo.Db;
 *     await mongo.collection('products').updateMany(
 *       {},
 *       { $rename: { 'oldField': 'newField' } }
 *     );
 *   },
 *   down: async (db) => {
 *     const mongo = db as import('mongoose').mongo.Db;
 *     await mongo.collection('products').updateMany(
 *       {},
 *       { $rename: { 'newField': 'oldField' } }
 *     );
 *   },
 * });
 *
 * const runner = new MigrationRunner(mongoose.connection.db, {
 *   store: new MongoMigrationStore(mongoose.connection.db),
 *   lock: createMongoLockAdapter({ connection }), // multi-replica safety
 * });
 * await runner.up(migrations);
 *
 * ## Deployment discipline
 *
 * Migrations should be executed by ONE owner — a deploy job, a CI step, or
 * a leader — not by every replica on startup. The optional `lock` (any
 * ecosystem `LockAdapter`) makes concurrent runners fail fast instead of
 * double-applying, and the pending set is recomputed INSIDE the lock so a
 * runner that waited on another deploy sees its writes. Two windows remain
 * host concerns and are deliberately documented instead of hidden:
 *   - a crash between `up()` and `record()` re-executes that migration on
 *     the next run — write migrations to be idempotent (`$rename`,
 *     `IF NOT EXISTS`, upserts);
 *   - `up()` and `record()` are not one transaction — stores backed by a
 *     transactional DB can override `record()` to join the migration's
 *     transaction.
 */

import { createHash, randomUUID } from "node:crypto";
import type { LockAdapter } from "@classytic/repo-core/lock";
import { startRenewingLease } from "../lock/renewingLease.js";

// ============================================================================
// Types
// ============================================================================

export interface Migration {
  /** Migration version (sequential number) */
  version: number;

  /** Resource name this migration applies to */
  resource: string;

  /** Description of the migration */
  description?: string;

  /**
   * Forward migration (apply schema change).
   * The `db` parameter is whatever connection object you pass to the runner.
   */
  up: (db: unknown) => Promise<void>;

  /**
   * Backward migration (revert schema change).
   */
  down: (db: unknown) => Promise<void>;

  /**
   * Optional validation that data is compatible after migration
   */
  validate?: (db: unknown) => Promise<boolean>;
}

export interface MigrationRecord {
  version: number;
  resource: string;
  description?: string;
  appliedAt: Date;
  executionTime: number;
  /**
   * SHA-256 of the migration's `up` + `down` source at apply time.
   * Present on records written by 2.24+; older records lack it and are
   * skipped by drift detection.
   */
  checksum?: string;
}

/**
 * DB-agnostic migration store interface.
 *
 * Users implement this for their database:
 * - MongoMigrationStore (uses a `_migrations` collection)
 * - PrismaMigrationStore (uses a `_migrations` table)
 * - or any custom store
 */
export interface MigrationStore {
  /** Get all applied migration records, sorted by appliedAt ascending */
  getApplied(): Promise<MigrationRecord[]>;
  /**
   * Record a completed migration. `meta.checksum` (2.24+) is the source
   * checksum for drift detection — stores should persist it when given;
   * existing two-argument implementations remain valid and simply skip it.
   */
  record(migration: Migration, executionTime: number, meta?: { checksum?: string }): Promise<void>;
  /** Remove a migration record (for rollback) */
  remove(migration: Migration): Promise<void>;
}

/**
 * Minimal logger interface — matches Fastify's logger, pino, console, etc.
 */
export interface MigrationLogger {
  info(msg: string): void;
  error(msg: string): void;
}

/** Default logger that writes to stdout/stderr */
const defaultLogger: MigrationLogger = {
  info: (msg: string) => process.stdout.write(`${msg}\n`),
  error: (msg: string) => process.stderr.write(`${msg}\n`),
};

// ============================================================================
// Built-in MongoDB Migration Store
// ============================================================================

/**
 * MongoDB-backed migration store.
 *
 * Uses a `_migrations` collection in the same database.
 * The `db` parameter accepts any object with a `.collection()` method
 * (Mongoose db, native MongoDB Db, etc.)
 */
/**
 * Structural subset of a Mongo collection arc consumes. Held as a
 * driver-free interface so this file never imports `mongodb` /
 * `mongoose` — both Mongoose's `Connection.db.collection(...)` and the
 * native `MongoClient.db().collection(...)` satisfy this shape.
 *
 * The fluent `find().sort().toArray()` chain is typed loosely with
 * `unknown[]`; we cast to `MigrationRecord[]` once at the boundary
 * inside `getApplied()`.
 */
interface MongoCollectionLike {
  find(query: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      toArray(): Promise<unknown[]>;
    };
  };
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
}

interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
}

export class MongoMigrationStore implements MigrationStore {
  private readonly collectionName: string;
  private readonly db: MongoDbLike;

  constructor(db: MongoDbLike, opts?: { collectionName?: string }) {
    this.db = db;
    this.collectionName = opts?.collectionName ?? "_migrations";
  }

  async getApplied(): Promise<MigrationRecord[]> {
    const collection = this.db.collection(this.collectionName);
    const records = await collection.find({}).sort({ appliedAt: 1 }).toArray();
    return records as MigrationRecord[];
  }

  async record(
    migration: Migration,
    executionTime: number,
    meta?: { checksum?: string },
  ): Promise<void> {
    const collection = this.db.collection(this.collectionName);
    await collection.insertOne({
      version: migration.version,
      resource: migration.resource,
      description: migration.description,
      appliedAt: new Date(),
      executionTime,
      ...(meta?.checksum ? { checksum: meta.checksum } : {}),
    });
  }

  async remove(migration: Migration): Promise<void> {
    const collection = this.db.collection(this.collectionName);
    await collection.deleteOne({
      version: migration.version,
      resource: migration.resource,
    });
  }
}

// ============================================================================
// Migration Runner
// ============================================================================

export interface MigrationRunnerOptions {
  /** Migration store (required — use MongoMigrationStore or implement your own) */
  store: MigrationStore;
  /** Logger (defaults to process.stdout/stderr) */
  logger?: MigrationLogger;
  /**
   * Ecosystem lock adapter (`LockAdapter` from `@classytic/repo-core/lock`)
   * for multi-replica / concurrent-deploy safety.
   * When set, `up()` / `down()` / `downTo()` acquire the `arc:migrations`
   * lease first and FAIL FAST if another runner holds it — two replicas
   * starting together can no longer both execute the same migration.
   * Omit only when a single owner (deploy job, CI step) runs migrations.
   */
  lock?: LockAdapter;
  /**
   * Lease duration for the migration lock (default: 10 minutes). Must
   * comfortably exceed the slowest migration so the lease cannot lapse
   * mid-run and admit a second runner.
   */
  lockLeaseMs?: number;
  /** Lease holder identity (default: random per runner instance). */
  holderId?: string;
  /**
   * What to do when an APPLIED migration's current source no longer matches
   * the checksum recorded at apply time (the file was edited after being
   * applied — drift that silently invalidates rollback correctness).
   *   - `'warn'` (default) — log and continue. Checksums come from
   *     `Function.prototype.toString()`, so a transpile-target change can
   *     shift them without semantic drift; warn keeps that honest.
   *   - `'error'` — throw before running anything.
   * Records without a checksum (written by older stores) are skipped.
   */
  checksumMismatch?: "warn" | "error";
}

const MIGRATION_LOCK_NAME = "arc:migrations";
const DEFAULT_LOCK_LEASE_MS = 10 * 60 * 1000;

/**
 * Source checksum for drift detection — SHA-256 over the migration's
 * `up`/`down` source. Stable for a given build; a transpile-target change
 * can legitimately shift it (hence `checksumMismatch: 'warn'` default).
 */
export function computeMigrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(migration.up.toString())
    .update("\n")
    .update(migration.down.toString())
    .digest("hex");
}

/**
 * Define a migration
 */
export function defineMigration(migration: Migration): Migration {
  return migration;
}

/**
 * Migration Runner
 *
 * DB-agnostic. Manages execution of migrations with tracking and rollback.
 * The `db` parameter is passed through to migration `up`/`down` functions
 * as-is — the runner never touches it directly.
 *
 * @example
 * ```typescript
 * // MongoDB
 * const runner = new MigrationRunner(mongoose.connection.db, {
 *   store: new MongoMigrationStore(mongoose.connection.db),
 * });
 *
 * // Prisma
 * const runner = new MigrationRunner(prisma, {
 *   store: new PrismaMigrationStore(prisma), // user-implemented
 * });
 *
 * await runner.up(migrations);
 * ```
 */
export class MigrationRunner {
  private readonly db: unknown;
  private readonly store: MigrationStore;
  private readonly log: MigrationLogger;
  private readonly lock?: LockAdapter;
  private readonly lockLeaseMs: number;
  private readonly holderId: string;
  private readonly checksumMismatch: "warn" | "error";

  constructor(db: unknown, opts: MigrationRunnerOptions) {
    this.db = db;
    this.store = opts.store;
    this.log = opts.logger ?? defaultLogger;
    this.lock = opts.lock;
    this.lockLeaseMs = opts.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS;
    this.holderId = opts.holderId ?? `migration-runner-${randomUUID()}`;
    this.checksumMismatch = opts.checksumMismatch ?? "warn";
  }

  /**
   * Acquire the migration lease (when a lock is configured) and run `fn`.
   * Fail-fast on contention: a concurrent deploy should error loudly, not
   * queue — the OTHER runner is applying the same set.
   *
   * The lease renews while `fn` runs (`startRenewingLease` — serialized,
   * awaited teardown), so a migration slower than `lockLeaseMs` can't let
   * a second deployment acquire the lock mid-run. Ownership loss is
   * ENFORCED, not just logged: `fn` receives a `leaseLost` probe to refuse
   * starting further migrations, and even a successful `fn` fails the run
   * when the lease was lost — a concurrent runner may have interleaved, so
   * the applied state must be verified, not trusted. (A stale holder's
   * in-flight write can only be truly fenced by a token from the lock
   * contract — planned repo-core evolution.)
   */
  private async withLock<T>(fn: (leaseLost: () => boolean) => Promise<T>): Promise<T> {
    const lock = this.lock;
    if (!lock) return fn(() => false);

    // Fenced acquire when available — see the schedules plugin for why the
    // token matters beyond `lost`. A migration that lost and re-took the lock
    // must NOT keep applying steps: another runner may have advanced state.
    const fenced = await lock.tryAcquireFenced?.(
      MIGRATION_LOCK_NAME,
      this.holderId,
      this.lockLeaseMs,
    );
    const acquired =
      fenced !== undefined
        ? fenced !== null
        : await lock.tryAcquire(MIGRATION_LOCK_NAME, this.holderId, this.lockLeaseMs);
    if (!acquired) {
      throw new Error(
        "MigrationRunner: another runner holds the migration lock — refusing to run concurrently. " +
          "If a previous runner crashed, the lease expires on its own " +
          `(leaseMs: ${this.lockLeaseMs}).`,
      );
    }

    const lease = startRenewingLease({
      lock,
      name: MIGRATION_LOCK_NAME,
      holderId: this.holderId,
      leaseMs: this.lockLeaseMs,
      ...(fenced ? { token: fenced.token } : {}),
      onLost: () =>
        this.log.error(
          "MigrationRunner: lease renewal lost — another holder took the migration lock; " +
            "no further migrations will start and this run will fail.",
        ),
      onError: (error) =>
        this.log.error(
          `MigrationRunner: lease renewal errored (lease may lapse mid-run): ${(error as Error).message}`,
        ),
    });

    try {
      const result = await fn(() => lease.lost);
      if (lease.lost) {
        throw new Error(
          "MigrationRunner: migration lock ownership was lost mid-run — a concurrent " +
            "runner may have executed migrations in parallel. Verify the applied state " +
            "(getAppliedMigrations) before re-running.",
        );
      }
      return result;
    } finally {
      await lease.stop();
      try {
        await lock.release(MIGRATION_LOCK_NAME, this.holderId);
      } catch (error) {
        // The lease self-expires; a failed release must not mask fn()'s result.
        this.log.error(`MigrationRunner: lock release failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Drift detection: compare each APPLIED record's stored checksum against
   * the current source of the same migration. A mismatch means the file was
   * edited after being applied — its `down()` may no longer invert what
   * actually ran.
   */
  private verifyChecksums(applied: MigrationRecord[], migrations: Migration[]): void {
    for (const record of applied) {
      if (!record.checksum) continue; // older record — nothing to compare
      const current = migrations.find(
        (m) => m.resource === record.resource && m.version === record.version,
      );
      if (!current) continue;
      const checksum = computeMigrationChecksum(current);
      if (checksum !== record.checksum) {
        const msg =
          `Migration ${record.resource}:${record.version} source changed after it was applied ` +
          `(checksum ${record.checksum.slice(0, 12)}… → ${checksum.slice(0, 12)}…). ` +
          "Ship a NEW migration instead of editing an applied one.";
        if (this.checksumMismatch === "error") {
          throw new Error(`MigrationRunner: ${msg}`);
        }
        this.log.error(`WARNING: ${msg}`);
      }
    }
  }

  /**
   * Run all pending migrations.
   *
   * With a `lock` configured, the applied set is (re)read INSIDE the lease —
   * a runner that raced another deploy computes pending against the winner's
   * completed writes, not a stale pre-lock snapshot.
   */
  async up(migrations: Migration[]): Promise<void> {
    await this.withLock(async (leaseLost) => {
      const applied = await this.store.getApplied();
      this.verifyChecksums(applied, migrations);
      const appliedVersions = new Set(applied.map((m) => `${m.resource}:${m.version}`));

      const pending = migrations
        .filter((m) => !appliedVersions.has(`${m.resource}:${m.version}`))
        .sort((a, b) => a.version - b.version);

      if (pending.length === 0) {
        this.log.info("No pending migrations");
        return;
      }

      this.log.info(`Running ${pending.length} migration(s)...`);

      for (const migration of pending) {
        if (leaseLost()) {
          throw new Error(
            "MigrationRunner: refusing to start the next migration — lock ownership lost.",
          );
        }
        await this.runMigration(migration, "up");
      }

      this.log.info("All migrations completed successfully");
    });
  }

  /**
   * Rollback last migration
   */
  async down(migrations: Migration[]): Promise<void> {
    await this.withLock(async (leaseLost) => {
      const applied = await this.store.getApplied();
      const last = applied[applied.length - 1];
      if (!last) {
        this.log.info("No migrations to rollback");
        return;
      }

      const migration = migrations.find(
        (m) => m.resource === last.resource && m.version === last.version,
      );

      if (!migration) {
        throw new Error(`Migration ${last.resource}:${last.version} not found in migration files`);
      }

      // `up` and `downTo` have always checked this in their loops; `down`
      // never did, because it runs a single step and looked like it had no
      // window. It has one: `getApplied()` is a round trip, and the lease can
      // lapse — or change epoch — across it. This is the DESTRUCTIVE path, so
      // it is the last one that should proceed on stale ownership: the
      // `applied` list it just read may already belong to another runner.
      if (leaseLost()) {
        throw new Error(
          "MigrationRunner: refusing to roll back — lock ownership lost between " +
            "acquiring the lease and starting the rollback.",
        );
      }

      this.log.info(`Rolling back ${migration.resource} v${migration.version}...`);
      await this.runMigration(migration, "down", true);
      this.log.info("Rollback completed");
    });
  }

  /**
   * Rollback to a specific version.
   *
   * Versions are RESOURCE-scoped, so a bare numeric threshold is only
   * meaningful within one resource. When the applied set spans multiple
   * resources, `options.resource` is required — rolling every resource back
   * across a shared number silently reverts unrelated schemas.
   */
  async downTo(
    migrations: Migration[],
    targetVersion: number,
    options?: { resource?: string },
  ): Promise<void> {
    await this.withLock(async (leaseLost) => {
      const applied = await this.store.getApplied();

      const resources = new Set(applied.map((m) => m.resource));
      if (!options?.resource && resources.size > 1) {
        throw new Error(
          `MigrationRunner.downTo: applied migrations span ${resources.size} resources ` +
            `(${[...resources].sort().join(", ")}) — versions are resource-scoped, so pass ` +
            "{ resource: '<name>' } to select which one to roll back.",
        );
      }

      const inScope = options?.resource
        ? applied.filter((m) => m.resource === options.resource)
        : applied;
      const toRollback = inScope.filter((m) => m.version > targetVersion).reverse();

      if (toRollback.length === 0) {
        this.log.info(`Already at or below version ${targetVersion}`);
        return;
      }

      this.log.info(`Rolling back ${toRollback.length} migration(s)...`);

      for (const record of toRollback) {
        if (leaseLost()) {
          throw new Error(
            "MigrationRunner: refusing to start the next rollback — lock ownership lost.",
          );
        }
        const migration = migrations.find(
          (m) => m.resource === record.resource && m.version === record.version,
        );

        if (!migration) {
          throw new Error(`Migration ${record.resource}:${record.version} not found`);
        }

        await this.runMigration(migration, "down", true);
      }

      this.log.info("Rollback completed");
    });
  }

  /**
   * Get all applied migrations
   */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    return this.store.getApplied();
  }

  async getPendingMigrations(migrations: Migration[]): Promise<Migration[]> {
    const applied = await this.store.getApplied();
    const appliedVersions = new Set(applied.map((m) => `${m.resource}:${m.version}`));
    return migrations.filter((m) => !appliedVersions.has(`${m.resource}:${m.version}`));
  }

  /**
   * Check if migrations are up to date
   */
  async isUpToDate(migrations: Migration[]): Promise<boolean> {
    const pending = await this.getPendingMigrations(migrations);
    return pending.length === 0;
  }

  /**
   * Run a single migration
   */
  private async runMigration(
    migration: Migration,
    direction: "up" | "down",
    isRollback = false,
  ): Promise<void> {
    const start = Date.now();
    const action = direction === "up" ? "Applying" : "Rolling back";
    const label = `${migration.resource} v${migration.version}`;
    const desc = migration.description ? `: ${migration.description}` : "";

    this.log.info(`${action} ${label}${desc}...`);

    try {
      if (direction === "up") {
        await migration.up(this.db);

        if (migration.validate) {
          const valid = await migration.validate(this.db);
          if (!valid) {
            throw new Error("Migration validation failed");
          }
        }

        await this.store.record(migration, Date.now() - start, {
          checksum: computeMigrationChecksum(migration),
        });
      } else {
        await migration.down(this.db);

        if (isRollback) {
          await this.store.remove(migration);
        }
      }

      const duration = Date.now() - start;
      this.log.info(`${label} completed (${duration}ms)`);
    } catch (error) {
      this.log.error(`${label} failed: ${(error as Error).message}`);
      throw error;
    }
  }
}

// ============================================================================
// Schema Versioning
// ============================================================================

/**
 * Schema version definition for resources
 */
export interface SchemaVersion {
  version: number;
  migrations: Migration[];
}

/**
 * Add versioning to resource definition
 *
 * @example
 * export default defineResource({
 *   name: 'product',
 *   version: 2,
 *   migrations: [productV1ToV2Migration],
 *   // ... rest of resource definition
 * });
 */
export function withSchemaVersion(version: number, migrations: Migration[]): SchemaVersion {
  return { version, migrations };
}

// ============================================================================
// Migration Registry
// ============================================================================

/**
 * Global migration registry
 */
export class MigrationRegistry {
  private migrations: Map<string, Migration[]> = new Map();

  /**
   * Register a migration
   */
  register(migration: Migration): void {
    const existing = this.migrations.get(migration.resource) || [];
    existing.push(migration);
    existing.sort((a, b) => a.version - b.version);
    this.migrations.set(migration.resource, existing);
  }

  /**
   * Register multiple migrations
   */
  registerMany(migrations: Migration[]): void {
    for (const migration of migrations) {
      this.register(migration);
    }
  }

  /**
   * Get all migrations for a resource
   */
  getForResource(resource: string): Migration[] {
    return this.migrations.get(resource) || [];
  }

  /**
   * Get all migrations
   */
  getAll(): Migration[] {
    const all: Migration[] = [];
    for (const migrations of this.migrations.values()) {
      all.push(...migrations);
    }
    return all.sort((a, b) => a.version - b.version);
  }

  /**
   * Get migration by resource and version
   */
  get(resource: string, version: number): Migration | undefined {
    const migrations = this.migrations.get(resource) || [];
    return migrations.find((m) => m.version === version);
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.migrations.clear();
  }
}
