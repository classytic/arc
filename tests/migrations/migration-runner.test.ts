import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  defineMigration,
  MigrationRunner,
  MigrationRegistry,
  withSchemaVersion,
  type MigrationStore,
  type Migration,
  type MigrationRecord,
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
    const m = defineMigration({ version: 1, resource: "p", up: async () => {}, down: async () => {} });
    const sv = withSchemaVersion(2, [m]);
    expect(sv.version).toBe(2);
    expect(sv.migrations).toHaveLength(1);
  });
});

describe("MigrationRegistry", () => {
  it("registers and retrieves migrations by resource", () => {
    const registry = new MigrationRegistry();
    const m1 = defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} });
    const m2 = defineMigration({ version: 2, resource: "users", up: async () => {}, down: async () => {} });
    registry.register(m1);
    registry.register(m2);
    const forUsers = registry.getForResource("users");
    expect(forUsers).toHaveLength(2);
    expect(forUsers[0].version).toBe(1);
    expect(forUsers[1].version).toBe(2);
  });

  it("getAll returns all migrations sorted by version", () => {
    const registry = new MigrationRegistry();
    registry.register(defineMigration({ version: 3, resource: "posts", up: async () => {}, down: async () => {} }));
    registry.register(defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].version).toBe(1);
    expect(all[1].version).toBe(3);
  });

  it("get returns specific migration", () => {
    const registry = new MigrationRegistry();
    const m = defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} });
    registry.register(m);
    expect(registry.get("users", 1)).toBe(m);
    expect(registry.get("users", 99)).toBeUndefined();
  });

  it("clear removes all migrations", () => {
    const registry = new MigrationRegistry();
    registry.register(defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => {} }));
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
      defineMigration({ version: 2, resource: "users", up: async () => { order.push(2); }, down: async () => {} }),
      defineMigration({ version: 1, resource: "users", up: async () => { order.push(1); }, down: async () => {} }),
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
      defineMigration({ version: 1, resource: "users", up: async () => {}, down: async () => { order.push(1); } }),
      defineMigration({ version: 2, resource: "users", up: async () => {}, down: async () => { order.push(2); } }),
      defineMigration({ version: 3, resource: "users", up: async () => {}, down: async () => { order.push(3); } }),
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
        version: 1, resource: "users",
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
        version: 1, resource: "users",
        up: async () => {},
        down: async () => {},
        validate: async () => false,
      }),
    ];

    const runner = new MigrationRunner({}, { store, logger: silentLogger });
    await expect(runner.up(migrations)).rejects.toThrow("validation failed");
  });
});
