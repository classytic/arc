import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  defineMigration,
  MigrationRunner,
  MigrationRegistry,
  type MigrationStore,
  type Migration,
} from "../../src/migrations/index.js";

describe("defineMigration()", () => {
  it("creates a migration with name and up/down functions", () => {
    const m = defineMigration({
      name: "001-add-users",
      up: async () => {},
      down: async () => {},
    });
    expect(m.name).toBe("001-add-users");
    expect(typeof m.up).toBe("function");
    expect(typeof m.down).toBe("function");
  });

  it("supports optional description", () => {
    const m = defineMigration({
      name: "002-add-index",
      description: "Add index to users collection",
      up: async () => {},
      down: async () => {},
    });
    expect(m.description).toBe("Add index to users collection");
  });
});

describe("MigrationRegistry", () => {
  it("registers and retrieves migrations in order", () => {
    const registry = new MigrationRegistry();
    const m1 = defineMigration({ name: "001", up: async () => {}, down: async () => {} });
    const m2 = defineMigration({ name: "002", up: async () => {}, down: async () => {} });
    registry.add(m1);
    registry.add(m2);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("001");
    expect(all[1].name).toBe("002");
  });

  it("prevents duplicate migration names", () => {
    const registry = new MigrationRegistry();
    const m = defineMigration({ name: "001", up: async () => {}, down: async () => {} });
    registry.add(m);
    expect(() => registry.add(m)).toThrow();
  });
});

describe("MigrationRunner", () => {
  let store: MigrationStore;
  let appliedMigrations: string[];

  beforeEach(() => {
    appliedMigrations = [];
    store = {
      getApplied: vi.fn().mockImplementation(async () => appliedMigrations),
      record: vi.fn().mockImplementation(async (name: string) => {
        appliedMigrations.push(name);
      }),
      remove: vi.fn().mockImplementation(async (name: string) => {
        appliedMigrations = appliedMigrations.filter((n) => n !== name);
      }),
    };
  });

  it("runs pending migrations in order", async () => {
    const order: string[] = [];
    const migrations: Migration[] = [
      defineMigration({
        name: "001",
        up: async () => { order.push("001"); },
        down: async () => {},
      }),
      defineMigration({
        name: "002",
        up: async () => { order.push("002"); },
        down: async () => {},
      }),
    ];

    const runner = new MigrationRunner({} as unknown, { store, migrations });
    await runner.up();
    expect(order).toEqual(["001", "002"]);
    expect(store.record).toHaveBeenCalledTimes(2);
  });

  it("skips already-applied migrations", async () => {
    appliedMigrations = ["001"];
    const upFn = vi.fn();
    const migrations: Migration[] = [
      defineMigration({ name: "001", up: upFn, down: async () => {} }),
      defineMigration({ name: "002", up: upFn, down: async () => {} }),
    ];

    const runner = new MigrationRunner({} as unknown, { store, migrations });
    await runner.up();
    // Only 002 should run (001 already applied)
    expect(upFn).toHaveBeenCalledOnce();
  });

  it("rolls back migrations in reverse order", async () => {
    appliedMigrations = ["001", "002"];
    const order: string[] = [];
    const migrations: Migration[] = [
      defineMigration({
        name: "001",
        up: async () => {},
        down: async () => { order.push("down-001"); },
      }),
      defineMigration({
        name: "002",
        up: async () => {},
        down: async () => { order.push("down-002"); },
      }),
    ];

    const runner = new MigrationRunner({} as unknown, { store, migrations });
    await runner.down();
    expect(order[0]).toBe("down-002");
    expect(store.remove).toHaveBeenCalled();
  });

  it("getPendingMigrations returns unapplied migrations", async () => {
    appliedMigrations = ["001"];
    const migrations: Migration[] = [
      defineMigration({ name: "001", up: async () => {}, down: async () => {} }),
      defineMigration({ name: "002", up: async () => {}, down: async () => {} }),
      defineMigration({ name: "003", up: async () => {}, down: async () => {} }),
    ];

    const runner = new MigrationRunner({} as unknown, { store, migrations });
    const pending = await runner.getPendingMigrations();
    expect(pending.map((m) => m.name)).toEqual(["002", "003"]);
  });

  it("isUpToDate returns true when all applied", async () => {
    appliedMigrations = ["001", "002"];
    const migrations: Migration[] = [
      defineMigration({ name: "001", up: async () => {}, down: async () => {} }),
      defineMigration({ name: "002", up: async () => {}, down: async () => {} }),
    ];

    const runner = new MigrationRunner({} as unknown, { store, migrations });
    expect(await runner.isUpToDate()).toBe(true);
  });

  it("isUpToDate returns false when pending exist", async () => {
    appliedMigrations = ["001"];
    const migrations: Migration[] = [
      defineMigration({ name: "001", up: async () => {}, down: async () => {} }),
      defineMigration({ name: "002", up: async () => {}, down: async () => {} }),
    ];

    const runner = new MigrationRunner({} as unknown, { store, migrations });
    expect(await runner.isUpToDate()).toBe(false);
  });

  it("passes db to migration up/down functions", async () => {
    const db = { connection: "mock-db" };
    const upFn = vi.fn();
    const migrations: Migration[] = [
      defineMigration({ name: "001", up: upFn, down: async () => {} }),
    ];

    const runner = new MigrationRunner(db as unknown, { store, migrations });
    await runner.up();
    expect(upFn).toHaveBeenCalledWith(db);
  });
});
