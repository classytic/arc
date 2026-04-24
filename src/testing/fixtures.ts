/**
 * TestFixtures — first-class record seeding for arc tests
 *
 * The fixture API is DB-agnostic: callers register factories that know how to
 * persist a record in their adapter of choice. Arc tracks inserted IDs for
 * automatic cleanup, so tests don't leak state between suites.
 *
 *   const fixtures = createTestFixtures();
 *
 *   fixtures.register('user', async (data) => UserModel.create(data));
 *   fixtures.register('org',  async (data) => OrgModel.create(data));
 *
 *   const org  = await fixtures.create('org', { name: 'Acme' });
 *   const user = await fixtures.create('user', { orgId: org._id });
 *   const bulk = await fixtures.createMany('user', 5, { orgId: org._id });
 *
 *   afterEach(() => fixtures.clear());
 *
 * Zero dependency on Mongoose, Prisma, or any specific DB — the factory is
 * the contract. `InMemoryDatabase` + mongokit adapters ship the Mongoose
 * flavor; Prisma / sqlitekit / custom adapters wire their own.
 */

import type { AnyRecord } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export type FixtureFactory<T extends AnyRecord = AnyRecord> = (data: Partial<T>) => Promise<T>;

/** Delete hook invoked by `clear()` for records that were created through a factory. */
export type FixtureDestroyer<T extends AnyRecord = AnyRecord> = (record: T) => Promise<void>;

export interface FixtureRegistration<T extends AnyRecord = AnyRecord> {
  create: FixtureFactory<T>;
  /** Optional cleanup. Defaults to a no-op; adapters that support deletion should provide one. */
  destroy?: FixtureDestroyer<T>;
}

export interface TestFixtures {
  /** Register a named factory. Later calls replace the earlier registration. */
  register<T extends AnyRecord = AnyRecord>(
    name: string,
    factoryOrRegistration: FixtureFactory<T> | FixtureRegistration<T>,
  ): void;
  /** Create one record through the named factory. Tracked for cleanup. */
  create<T extends AnyRecord = AnyRecord>(name: string, data?: Partial<T>): Promise<T>;
  /** Create many records with a shared template. Tracked for cleanup. */
  createMany<T extends AnyRecord = AnyRecord>(
    name: string,
    count: number,
    template?: Partial<T>,
  ): Promise<T[]>;
  /**
   * Run every registered `destroy` hook over the records this instance
   * created, then forget them. Safe to call multiple times (idempotent).
   * Factories without a `destroy` hook silently skip — assume the test
   * harness tears the whole DB down at the end.
   */
  clear(): Promise<void>;
  /** All records ever created by a given factory name (read-only snapshot). */
  all<T extends AnyRecord = AnyRecord>(name: string): readonly T[];
  /** Registered factory names. */
  readonly names: readonly string[];
}

// ============================================================================
// Implementation
// ============================================================================

export function createTestFixtures(): TestFixtures {
  const registry = new Map<string, FixtureRegistration>();

  /**
   * Each tracked record captures the destroyer that was registered AT CREATE
   * TIME. If a caller re-registers a name with a different destroyer after
   * records are in flight, the old records still clean up through the
   * destroyer that actually knows how to destroy them. Previously the
   * tracker stored `name → records[]` and looked up the registry at
   * `clear()` time, which silently applied the wrong destroyer after a
   * re-register.
   */
  interface TrackedRecord {
    name: string;
    record: AnyRecord;
    destroy: FixtureDestroyer | undefined;
  }
  const tracked: TrackedRecord[] = [];

  return {
    register(name, factoryOrRegistration) {
      const registration: FixtureRegistration =
        typeof factoryOrRegistration === "function"
          ? { create: factoryOrRegistration as FixtureFactory }
          : (factoryOrRegistration as FixtureRegistration);
      registry.set(name, registration);
    },

    async create(name, data) {
      const reg = registry.get(name);
      if (!reg) {
        throw new Error(
          `TestFixtures.create('${name}'): unknown factory. Registered: [${[...registry.keys()].join(", ") || "none"}]`,
        );
      }
      const record = await reg.create((data ?? {}) as Partial<AnyRecord>);
      // Bind THIS registration's destroyer to the record now — not at
      // clear-time lookup.
      tracked.push({ name, record, destroy: reg.destroy });
      return record as never;
    },

    async createMany(name, count, template) {
      if (count < 0) throw new Error(`TestFixtures.createMany: count must be >= 0, got ${count}`);
      const results: AnyRecord[] = [];
      for (let i = 0; i < count; i++) {
        const record = await (this as TestFixtures).create(name, template as never);
        results.push(record);
      }
      return results as never;
    },

    async clear() {
      // Iterate newest-first so destroyers that chain references (e.g. a
      // user that depends on an org still existing) see their targets when
      // they run. Callers needing strict ordering can split into multiple
      // fixture instances.
      for (let i = tracked.length - 1; i >= 0; i--) {
        const entry = tracked[i]!;
        if (entry.destroy) {
          await entry.destroy(entry.record).catch(() => {
            /* swallow — tests tear the whole DB down anyway */
          });
        }
      }
      tracked.length = 0;
    },

    all(name) {
      return tracked
        .filter((t) => t.name === name)
        .map((t) => t.record) as readonly AnyRecord[] as never;
    },

    get names() {
      return [...registry.keys()];
    },
  };
}
