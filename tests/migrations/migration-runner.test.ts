import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeMigrationChecksum,
  defineMigration,
  type Migration,
  type MigrationRecord,
  MigrationRegistry,
  MigrationRunner,
  type MigrationStore,
  withSchemaVersion,
} from "../../src/migrations/index.js";

// Silent logger for tests
const silentLogger = { info: () => {}, error: () => {} };

describe("defineMigration()", () => {
  it("creates a migration with version, resource, up/down", () => {
    const m = defineMigration({
      version: 1,
      resource: "users",
      up: async () => {},
      down: async () => {},
    });
    expect(m.version).toBe(1);
    expect(m.resource).toBe("users");
    expect(typeof m.up).toBe("function");
    expect(typeof m.down).toBe("function");
  });

  it("supports optional description", () => {
    const m = defineMigration({
      version: 2,
      resource: "users",
      description: "Add email index",
      up: async () => {},
      down: async () => {},
    });
    expect(m.description).toBe("Add email index");
  });
});

describe("withSchemaVersion()", () => {
  it("creates a schema version with migrations", () => {
    const m = defineMigration({
      version: 1,
      resource: "p",
      up: async () => {},
      down: async () => {},
    });
    const sv = withSchemaVersion(2, [m]);
    expect(sv.version).toBe(2);
    expect(sv.migrations).toHaveLength(1);
  });
});

describe("MigrationRegistry", () => {
  it("registers and retrieves migrations by resource", () => {
    const registry = new MigrationRegistry();
    const m1 = defineMigration({
      version: 1,
      resource: "users",
      up: async () => {},
      down: async () => {},
    });
    const m2 = defineMigration({
      version: 2,
      resource: "users",
      up: async () => {},
      down: async () => {},
    });
    registry.register(m1);
    registry.register(m2);
    const forUsers = registry.getForResource("users");
    expect(forUsers).toHaveLength(2);
    expect(forUsers[0].version).toBe(1);
    expect(forUsers[1].version).toBe(2);
  });

  it("getAll returns all migrations sorted by version", () => {
    const registry = new MigrationRegistry();
    registry.register(
      defineMigration({ version: 3, resource: "posts", up: async () => {}, down: async () => {} }),
    );
    registry.register(
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }),
    );
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].version).toBe(1);
    expect(all[1].version).toBe(3);
  });

  it("get returns specific migration", () => {
    const registry = new MigrationRegistry();
    const m = defineMigration({
      version: 1,
      resource: "users",
      up: async () => {},
      down: async () => {},
    });
    registry.register(m);
    expect(registry.get("users", 1)).toBe(m);
    expect(registry.get("users", 99)).toBeUndefined();
  });

  it("clear removes all migrations", () => {
    const registry = new MigrationRegistry();
    registry.register(
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }),
    );
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("registerMany registers multiple at once", () => {
    const registry = new MigrationRegistry();
    registry.registerMany([
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }),
      defineMigration({ version: 2, resource: "users", up: async () => {}, down: async () => {} }),
    ]);
    expect(registry.getAll()).toHaveLength(2);
  });
});

describe("MigrationRunner", () => {
  let store: MigrationStore;
  let appliedRecords: MigrationRecord[];

  beforeEach(() => {
    appliedRecords = [];
    store = {
      getApplied: vi.fn().mockImplementation(async () => appliedRecords),
      record: vi.fn().mockImplementation(async (migration: Migration) => {
        appliedRecords.push({
          version: migration.version,
          resource: migration.resource,
          appliedAt: new Date(),
          executionTime: 0,
        });
      }),
      remove: vi.fn().mockImplementation(async (migration: Migration) => {
        appliedRecords = appliedRecords.filter(
          (r) => !(r.resource === migration.resource && r.version === migration.version),
        );
      }),
    };
  });

  it("runs pending migrations in version order", async () => {
    const order: number[] = [];
    const migrations = [
      defineMigration({
        version: 2,
        resource: "users",
        up: async () => {
          order.push(2);
        },
        down: async () => {},
      }),
      defineMigration({
        version: 1,
        resource: "users",
        up: async () => {
          order.push(1);
        },
        down: async () => {},
      }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    await runner.up(migrations);
    expect(order).toEqual([1, 2]);
    expect(store.record).toHaveBeenCalledTimes(2);
  });

  it("skips already-applied migrations", async () => {
    appliedRecords = [{ version: 1, resource: "users", appliedAt: new Date(), executionTime: 0 }];
    const upFn = vi.fn();
    const migrations = [
      defineMigration({ version: 1, resource: "users", up: upFn, down: async () => {} }),
      defineMigration({ version: 2, resource: "users", up: upFn, down: async () => {} }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    await runner.up(migrations);
    expect(upFn).toHaveBeenCalledOnce(); // Only v2 runs
  });

  it("rolls back last migration", async () => {
    appliedRecords = [
      { version: 1, resource: "users", appliedAt: new Date(), executionTime: 0 },
      { version: 2, resource: "users", appliedAt: new Date(), executionTime: 0 },
    ];
    const downFn = vi.fn();
    const migrations = [
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }),
      defineMigration({ version: 2, resource: "users", up: async () => {}, down: downFn }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    await runner.down(migrations);
    expect(downFn).toHaveBeenCalledOnce();
    expect(store.remove).toHaveBeenCalled();
  });

  it("getPendingMigrations returns unapplied migrations", async () => {
    appliedRecords = [{ version: 1, resource: "users", appliedAt: new Date(), executionTime: 0 }];
    const migrations = [
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }),
      defineMigration({ version: 2, resource: "users", up: async () => {}, down: async () => {} }),
      defineMigration({ version: 3, resource: "users", up: async () => {}, down: async () => {} }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    const pending = await runner.getPendingMigrations(migrations);
    expect(pending.map((m) => m.version)).toEqual([2, 3]);
  });

  it("isUpToDate returns true when all applied", async () => {
    appliedRecords = [
      { version: 1, resource: "users", appliedAt: new Date(), executionTime: 0 },
      { version: 2, resource: "users", appliedAt: new Date(), executionTime: 0 },
    ];
    const migrations = [
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }),
      defineMigration({ version: 2, resource: "users", up: async () => {}, down: async () => {} }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    expect(await runner.isUpToDate(migrations)).toBe(true);
  });

  it("isUpToDate returns false when pending exist", async () => {
    appliedRecords = [{ version: 1, resource: "users", appliedAt: new Date(), executionTime: 0 }];
    const migrations = [
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }),
      defineMigration({ version: 2, resource: "users", up: async () => {}, down: async () => {} }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    expect(await runner.isUpToDate(migrations)).toBe(false);
  });

  it("passes db to migration up/down functions", async () => {
    const db = { connection: "mock-db" };
    const upFn = vi.fn();
    const migrations = [
      defineMigration({ version: 1, resource: "users", up: upFn, down: async () => {} }),
    ];

    const runner = new MigrationRunner(db, { store, logger: silentLogger });
    await runner.up(migrations);
    expect(upFn).toHaveBeenCalledWith(db);
  });

  it("downTo rolls back to target version", async () => {
    appliedRecords = [
      { version: 1, resource: "users", appliedAt: new Date(), executionTime: 0 },
      { version: 2, resource: "users", appliedAt: new Date(), executionTime: 0 },
      { version: 3, resource: "users", appliedAt: new Date(), executionTime: 0 },
    ];
    const order: number[] = [];
    const migrations = [
      defineMigration({
        version: 1,
        resource: "users",
        up: async () => {},
        down: async () => {
          order.push(1);
        },
      }),
      defineMigration({
        version: 2,
        resource: "users",
        up: async () => {},
        down: async () => {
          order.push(2);
        },
      }),
      defineMigration({
        version: 3,
        resource: "users",
        up: async () => {},
        down: async () => {
          order.push(3);
        },
      }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    await runner.downTo(migrations, 1);
    // Should roll back v3 and v2 (everything above v1)
    expect(order).toEqual([3, 2]);
  });

  it("runs validate after up if provided", async () => {
    const validateFn = vi.fn().mockResolvedValue(true);
    const migrations = [
      defineMigration({
        version: 1,
        resource: "users",
        up: async () => {},
        down: async () => {},
        validate: validateFn,
      }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    await runner.up(migrations);
    expect(validateFn).toHaveBeenCalled();
  });

  it("throws if validate returns false", async () => {
    const migrations = [
      defineMigration({
        version: 1,
        resource: "users",
        up: async () => {},
        down: async () => {},
        validate: async () => false,
      }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    await expect(runner.up(migrations)).rejects.toThrow("validation failed");
  });
});

// ============================================================================
// Distributed safety — lock, lease renewal, checksums, resource-aware downTo
// ============================================================================

describe("MigrationRunner — distributed safety", () => {
  class FakeStore implements MigrationStore {
    applied: MigrationRecord[] = [];
    recordMeta: Array<{ checksum?: string } | undefined> = [];
    calls: string[] = [];

    async getApplied(): Promise<MigrationRecord[]> {
      this.calls.push("getApplied");
      return [...this.applied];
    }

    async record(
      migration: Migration,
      executionTime: number,
      meta?: { checksum?: string },
    ): Promise<void> {
      this.calls.push(`record:${migration.resource}:${migration.version}`);
      this.recordMeta.push(meta);
      this.applied.push({
        version: migration.version,
        resource: migration.resource,
        appliedAt: new Date(),
        executionTime,
        ...(meta?.checksum ? { checksum: meta.checksum } : {}),
      });
    }

    async remove(migration: Migration): Promise<void> {
      this.calls.push(`remove:${migration.resource}:${migration.version}`);
      this.applied = this.applied.filter(
        (r) => !(r.resource === migration.resource && r.version === migration.version),
      );
    }
  }

  // Same-holder tryAcquire EXTENDS the lease (the LockAdapter contract) —
  // required for renewal assertions.
  class FakeLock {
    held = new Map<string, string>();
    calls: string[] = [];

    tryAcquire(name: string, holderId: string, _leaseMs: number): boolean {
      this.calls.push(`acquire:${name}`);
      const holder = this.held.get(name);
      if (holder && holder !== holderId) return false;
      this.held.set(name, holderId);
      return true;
    }

    release(name: string, _holderId: string): boolean {
      this.calls.push(`release:${name}`);
      this.held.delete(name);
      return true;
    }
  }

  function migration(resource: string, version: number, ops?: Partial<Migration>): Migration {
    return defineMigration({
      version,
      resource,
      up: ops?.up ?? (async () => {}),
      down: ops?.down ?? (async () => {}),
      ...(ops?.validate ? { validate: ops.validate } : {}),
    });
  }

  describe("lock", () => {
    it("acquires the arc:migrations lease, reads applied INSIDE it, releases after", async () => {
      const store = new FakeStore();
      const lock = new FakeLock();
      const order: string[] = [];
      const origGetApplied = store.getApplied.bind(store);
      store.getApplied = async () => {
        order.push("getApplied");
        return origGetApplied();
      };
      const origAcquire = lock.tryAcquire.bind(lock);
      lock.tryAcquire = (n, h, l) => {
        order.push("acquire");
        return origAcquire(n, h, l);
      };

      const runner = new MigrationRunner({}, { store, lock, logger: silentLogger });
      await runner.up([migration("product", 1)]);

      expect(order[0]).toBe("acquire");
      expect(order[1]).toBe("getApplied");
      expect(lock.calls[0]).toBe("acquire:arc:migrations");
      expect(lock.calls.at(-1)).toBe("release:arc:migrations");
      expect(lock.held.size).toBe(0);
    });

    it("fails fast when another runner holds the lock", async () => {
      const store = new FakeStore();
      const lock = new FakeLock();
      lock.held.set("arc:migrations", "other-runner");

      const runner = new MigrationRunner({}, { store, lock, logger: silentLogger });
      await expect(runner.up([migration("product", 1)])).rejects.toThrow(
        /another runner holds the migration lock/,
      );
      expect(store.calls).toEqual([]); // nothing executed
    });

    it("releases the lock even when a migration throws", async () => {
      const store = new FakeStore();
      const lock = new FakeLock();
      const runner = new MigrationRunner({}, { store, lock, logger: silentLogger });

      const failing = migration("product", 1, {
        up: async () => {
          throw new Error("boom");
        },
      });
      await expect(runner.up([failing])).rejects.toThrow("boom");
      expect(lock.held.size).toBe(0);
      expect(lock.calls).toContain("release:arc:migrations");
    });

    it("works without a lock (single-runner mode, back-compat)", async () => {
      const store = new FakeStore();
      const runner = new MigrationRunner({}, { store, logger: silentLogger });
      await runner.up([migration("product", 1)]);
      expect(store.applied).toHaveLength(1);
    });

    it("renews the lease while a migration outruns lockLeaseMs", async () => {
      const store = new FakeStore();
      const lock = new FakeLock();

      const runner = new MigrationRunner(
        {},
        { store, lock, logger: silentLogger, lockLeaseMs: 40 }, // renew every 20ms
      );
      const slow = migration("product", 1, {
        up: async () => {
          await new Promise((r) => setTimeout(r, 90)); // outruns the 40ms lease
        },
      });
      await runner.up([slow]);

      const acquires = lock.calls.filter((c) => c === "acquire:arc:migrations").length;
      expect(acquires).toBeGreaterThanOrEqual(3); // initial + ≥2 renewals
      expect(lock.calls.at(-1)).toBe("release:arc:migrations");
      expect(lock.held.size).toBe(0);
    });

    it("ownership loss FAILS the run — even when the migration itself succeeded", async () => {
      const store = new FakeStore();
      const lock = new FakeLock();

      const runner = new MigrationRunner(
        {},
        { store, lock, logger: silentLogger, lockLeaseMs: 40 },
      );
      const slow = migration("product", 1, {
        up: async () => {
          // Simulate another holder stealing the lock mid-run: the next
          // renewal (same-holder extend) must observe the loss.
          lock.held.set("arc:migrations", "intruder");
          await new Promise((r) => setTimeout(r, 60));
        },
      });
      await expect(runner.up([slow])).rejects.toThrow(/ownership was lost mid-run/);
    });
  });

  describe("checksums", () => {
    it("records a sha256 source checksum with every applied migration", async () => {
      const store = new FakeStore();
      const runner = new MigrationRunner({}, { store, logger: silentLogger });
      const m = migration("product", 1);
      await runner.up([m]);

      expect(store.recordMeta[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(store.recordMeta[0]?.checksum).toBe(computeMigrationChecksum(m));
    });

    it("warns (default) when an applied migration's source changed", async () => {
      const store = new FakeStore();
      const errors: string[] = [];
      const logger = { info: () => {}, error: (msg: string) => errors.push(msg) };

      const original = migration("product", 1);
      const runner1 = new MigrationRunner({}, { store, logger: silentLogger });
      await runner1.up([original]);

      // Same identity, different source — as if the file was edited post-apply.
      const edited = migration("product", 1, {
        up: async () => {
          void "edited";
        },
      });
      const runner2 = new MigrationRunner({}, { store, logger });
      await runner2.up([edited, migration("product", 2)]);

      expect(errors.some((e) => /source changed after it was applied/.test(e))).toBe(true);
      expect(store.applied.map((r) => r.version)).toEqual([1, 2]); // pending still ran
    });

    it("throws before running anything with checksumMismatch: 'error'", async () => {
      const store = new FakeStore();
      const runner1 = new MigrationRunner({}, { store, logger: silentLogger });
      await runner1.up([migration("product", 1)]);

      const edited = migration("product", 1, {
        up: async () => {
          void "edited";
        },
      });
      const runner2 = new MigrationRunner(
        {},
        { store, logger: silentLogger, checksumMismatch: "error" },
      );
      await expect(runner2.up([edited, migration("product", 2)])).rejects.toThrow(
        /source changed after it was applied/,
      );
      expect(store.applied.map((r) => r.version)).toEqual([1]); // v2 never ran
    });

    it("skips drift detection for records without a checksum (older stores)", async () => {
      const store = new FakeStore();
      store.applied.push({
        version: 1,
        resource: "product",
        appliedAt: new Date(),
        executionTime: 1,
        // no checksum — legacy record
      });
      const runner = new MigrationRunner(
        {},
        { store, logger: silentLogger, checksumMismatch: "error" },
      );
      await expect(runner.up([migration("product", 1)])).resolves.toBeUndefined();
    });
  });

  describe("resource-aware downTo", () => {
    it("throws when the applied set spans multiple resources and no resource is given", async () => {
      const store = new FakeStore();
      const runner = new MigrationRunner({}, { store, logger: silentLogger });
      const all = [migration("product", 1), migration("product", 2), migration("order", 1)];
      await runner.up(all);

      await expect(runner.downTo(all, 1)).rejects.toThrow(/resource-scoped/);
    });

    it("rolls back only the named resource", async () => {
      const store = new FakeStore();
      const runner = new MigrationRunner({}, { store, logger: silentLogger });
      const all = [
        migration("product", 1),
        migration("product", 2),
        migration("order", 1),
        migration("order", 2),
      ];
      await runner.up(all);

      await runner.downTo(all, 1, { resource: "product" });

      expect(store.applied.map((r) => `${r.resource}:${r.version}`).sort()).toEqual([
        "order:1",
        "order:2",
        "product:1",
      ]);
    });

    it("keeps the bare form for a single-resource applied set (back-compat)", async () => {
      const store = new FakeStore();
      const runner = new MigrationRunner({}, { store, logger: silentLogger });
      const all = [migration("product", 1), migration("product", 2), migration("product", 3)];
      await runner.up(all);

      await runner.downTo(all, 1);
      expect(store.applied.map((r) => r.version)).toEqual([1]);
    });
  });
});
