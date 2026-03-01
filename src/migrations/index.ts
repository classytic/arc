/**
 * Schema Versioning and Migrations System
 *
 * Manages database schema changes over time with version tracking.
 * Supports forward migrations, rollbacks, and schema compatibility layers.
 *
 * @example
 * import { defineMigration, MigrationRunner } from '@classytic/arc/migrations';
 *
 * const productV2 = defineMigration({
 *   version: 2,
 *   resource: 'product',
 *   up: async (db) => {
 *     await db.collection('products').updateMany(
 *       {},
 *       { $rename: { 'oldField': 'newField' } }
 *     );
 *   },
 *   down: async (db) => {
 *     await db.collection('products').updateMany(
 *       {},
 *       { $rename: { 'newField': 'oldField' } }
 *     );
 *   },
 * });
 *
 * const runner = new MigrationRunner(mongoose.connection.db);
 * await runner.up(); // Run all pending migrations
 */

import mongoose, { type Connection } from 'mongoose';

export interface Migration {
  /** Migration version (sequential number) */
  version: number;

  /** Resource name this migration applies to */
  resource: string;

  /** Description of the migration */
  description?: string;

  /**
   * Forward migration (apply schema change)
   */
  up: (db: mongoose.mongo.Db) => Promise<void>;

  /**
   * Backward migration (revert schema change)
   */
  down: (db: mongoose.mongo.Db) => Promise<void>;

  /**
   * Optional validation that data is compatible after migration
   */
  validate?: (db: mongoose.mongo.Db) => Promise<boolean>;
}

export interface MigrationRecord {
  version: number;
  resource: string;
  description?: string;
  appliedAt: Date;
  executionTime: number;
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
 * Manages execution of migrations with tracking and rollback support.
 */
export class MigrationRunner {
  private readonly collectionName = '_migrations';

  private readonly db: mongoose.mongo.Db;

  constructor(db: mongoose.mongo.Db) {
    this.db = db;
  }

  /**
   * Run all pending migrations
   */
  async up(migrations: Migration[]): Promise<void> {
    const applied = await this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map((m) => `${m.resource}:${m.version}`));

    // Sort migrations by version
    const pending = migrations
      .filter((m) => !appliedVersions.has(`${m.resource}:${m.version}`))
      .sort((a, b) => a.version - b.version);

    if (pending.length === 0) {
      console.log('No pending migrations');
      return;
    }

    console.log(`Running ${pending.length} migration(s)...\n`);

    for (const migration of pending) {
      await this.runMigration(migration, 'up');
    }

    console.log('\nAll migrations completed successfully');
  }

  /**
   * Rollback last migration
   */
  async down(migrations: Migration[]): Promise<void> {
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) {
      console.log('No migrations to rollback');
      return;
    }

    // Get last applied migration
    const last = applied[applied.length - 1];
    if (!last) {
      console.log('No migrations to rollback');
      return;
    }

    const migration = migrations.find(
      (m) => m.resource === last.resource && m.version === last.version
    );

    if (!migration) {
      throw new Error(
        `Migration ${last.resource}:${last.version} not found in migration files`
      );
    }

    console.log(`Rolling back ${migration.resource} v${migration.version}...`);
    await this.runMigration(migration, 'down', true);
    console.log('Rollback completed');
  }

  /**
   * Rollback to specific version
   */
  async downTo(migrations: Migration[], targetVersion: number): Promise<void> {
    const applied = await this.getAppliedMigrations();
    const toRollback = applied.filter((m) => m.version > targetVersion).reverse();

    if (toRollback.length === 0) {
      console.log(`Already at or below version ${targetVersion}`);
      return;
    }

    console.log(`Rolling back ${toRollback.length} migration(s)...\n`);

    for (const record of toRollback) {
      const migration = migrations.find(
        (m) => m.resource === record.resource && m.version === record.version
      );

      if (!migration) {
        throw new Error(`Migration ${record.resource}:${record.version} not found`);
      }

      await this.runMigration(migration, 'down', true);
    }

    console.log('\nRollback completed');
  }

  /**
   * Get all applied migrations
   */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    const collection = this.db.collection(this.collectionName);
    const records = await collection.find({}).sort({ appliedAt: 1 }).toArray();
    return records as unknown as MigrationRecord[];
  }

  /**
   * Get pending migrations
   */
  async getPendingMigrations(migrations: Migration[]): Promise<Migration[]> {
    const applied = await this.getAppliedMigrations();
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
    direction: 'up' | 'down',
    isRollback = false
  ): Promise<void> {
    const start = Date.now();
    const action = direction === 'up' ? 'Applying' : 'Rolling back';

    console.log(
      `${action} ${migration.resource} v${migration.version}${migration.description ? `: ${migration.description}` : ''}...`
    );

    try {
      // Run migration
      if (direction === 'up') {
        await migration.up(this.db);

        // Validate if provided
        if (migration.validate) {
          const valid = await migration.validate(this.db);
          if (!valid) {
            throw new Error('Migration validation failed');
          }
        }

        // Record migration
        await this.recordMigration(migration, Date.now() - start);
      } else {
        await migration.down(this.db);

        // Remove record
        if (isRollback) {
          await this.removeMigration(migration);
        }
      }

      const duration = Date.now() - start;
      console.log(`✅ ${migration.resource} v${migration.version} (${duration}ms)`);
    } catch (error) {
      console.error(
        `❌ ${migration.resource} v${migration.version} failed:`,
        (error as Error).message
      );
      throw error;
    }
  }

  /**
   * Record a completed migration
   */
  private async recordMigration(migration: Migration, executionTime: number): Promise<void> {
    const collection = this.db.collection(this.collectionName);
    await collection.insertOne({
      version: migration.version,
      resource: migration.resource,
      description: migration.description,
      appliedAt: new Date(),
      executionTime,
    });
  }

  /**
   * Remove a migration record
   */
  private async removeMigration(migration: Migration): Promise<void> {
    const collection = this.db.collection(this.collectionName);
    await collection.deleteOne({
      version: migration.version,
      resource: migration.resource,
    });
  }
}

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
export function withSchemaVersion(
  version: number,
  migrations: Migration[]
): SchemaVersion {
  return { version, migrations };
}

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

/**
 * Global migration registry instance
 */
export const migrationRegistry = new MigrationRegistry();

/**
 * Common migration helpers
 */
export const migrationHelpers = {
  /**
   * Rename a field across all documents
   */
  renameField: (collection: string, oldName: string, newName: string) =>
    defineMigration({
      version: 0,
      resource: collection,
      description: `Rename ${oldName} to ${newName}`,
      up: async (db) => {
        await db.collection(collection).updateMany({}, { $rename: { [oldName]: newName } });
      },
      down: async (db) => {
        await db.collection(collection).updateMany({}, { $rename: { [newName]: oldName } });
      },
    }),

  /**
   * Add a new field with default value
   */
  addField: (collection: string, fieldName: string, defaultValue: unknown) =>
    defineMigration({
      version: 0,
      resource: collection,
      description: `Add ${fieldName} field`,
      up: async (db) => {
        await db
          .collection(collection)
          .updateMany({ [fieldName]: { $exists: false } }, { $set: { [fieldName]: defaultValue } });
      },
      down: async (db) => {
        await db.collection(collection).updateMany({}, { $unset: { [fieldName]: '' } });
      },
    }),

  /**
   * Remove a field
   */
  removeField: (collection: string, fieldName: string) =>
    defineMigration({
      version: 0,
      resource: collection,
      description: `Remove ${fieldName} field`,
      up: async (db) => {
        await db.collection(collection).updateMany({}, { $unset: { [fieldName]: '' } });
      },
      down: async (db) => {
        // Cannot restore data - this is destructive
        console.warn(`Cannot restore ${fieldName} field - data was deleted`);
      },
    }),

  /**
   * Create an index
   */
  createIndex: (collection: string, fields: Record<string, 1 | -1>, options?: Record<string, unknown>) =>
    defineMigration({
      version: 0,
      resource: collection,
      description: `Create index on ${Object.keys(fields).join(', ')}`,
      up: async (db) => {
        await db.collection(collection).createIndex(fields, options);
      },
      down: async (db) => {
        const indexName = typeof options?.name === 'string' ? options.name : Object.keys(fields).join('_');
        await db.collection(collection).dropIndex(indexName);
      },
    }),
};
