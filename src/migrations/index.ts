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
 * });
 * await runner.up(migrations);
 */

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
  /** Record a completed migration */
  record(migration: Migration, executionTime: number): Promise<void>;
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

  async record(migration: Migration, executionTime: number): Promise<void> {
    const collection = this.db.collection(this.collectionName);
    await collection.insertOne({
      version: migration.version,
      resource: migration.resource,
      description: migration.description,
      appliedAt: new Date(),
      executionTime,
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

  constructor(db: unknown, opts: MigrationRunnerOptions) {
    this.db = db;
    this.store = opts.store;
    this.log = opts.logger ?? defaultLogger;
  }

  /**
   * Run all pending migrations
   */
  async up(migrations: Migration[]): Promise<void> {
    const applied = await this.store.getApplied();
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
      await this.runMigration(migration, "up");
    }

    this.log.info("All migrations completed successfully");
  }

  /**
   * Rollback last migration
   */
  async down(migrations: Migration[]): Promise<void> {
    const applied = await this.store.getApplied();
    if (applied.length === 0) {
      this.log.info("No migrations to rollback");
      return;
    }

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

    this.log.info(`Rolling back ${migration.resource} v${migration.version}...`);
    await this.runMigration(migration, "down", true);
    this.log.info("Rollback completed");
  }

  /**
   * Rollback to specific version
   */
  async downTo(migrations: Migration[], targetVersion: number): Promise<void> {
    const applied = await this.store.getApplied();
    const toRollback = applied.filter((m) => m.version > targetVersion).reverse();

    if (toRollback.length === 0) {
      this.log.info(`Already at or below version ${targetVersion}`);
      return;
    }

    this.log.info(`Rolling back ${toRollback.length} migration(s)...`);

    for (const record of toRollback) {
      const migration = migrations.find(
        (m) => m.resource === record.resource && m.version === record.version,
      );

      if (!migration) {
        throw new Error(`Migration ${record.resource}:${record.version} not found`);
      }

      await this.runMigration(migration, "down", true);
    }

    this.log.info("Rollback completed");
  }

  /**
   * Get all applied migrations
   */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    return this.store.getApplied();
  }

  /**
   * Get pending migrations
   */
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

        await this.store.record(migration, Date.now() - start);
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
