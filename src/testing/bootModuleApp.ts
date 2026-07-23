/**
 * bootModuleApp — the module-composability proof harness (2.22).
 *
 * Boots a REAL arc app around one or more modules on an in-memory
 * MongoDB, and returns the app + connection + a one-call teardown. This
 * is the contract the arc ecosystem tests against:
 *
 * > **If your module boots green in bootModuleApp, it composes** — in
 * > any host, monolith or split-service. The same suite should pass in
 * > both shapes.
 *
 * ```typescript
 * const t = await bootModuleApp(({ connection }) => [
 *   createAccountingModule({ connection, permissions }),
 * ]);
 * const res = await t.app.inject({ method: 'GET', url: '/accounting/accounts' });
 * await t.close();
 * ```
 *
 * Module thunks are supported INSIDE an array (`bootModuleApp([async () =>
 * createXModule(...)])`); a BARE function argument is always treated as
 * the context factory. Engines that need the DB boot inside a thunk or
 * the factory — the connection is live before module resolution starts.
 *
 * mongodb-memory-server + mongoose load lazily (dev-time fixtures — same
 * contract as `createTestApp`); `replset: true` boots a single-node
 * replica set for transactional kernels.
 */

import type { FastifyInstance } from "fastify";
import { createApp } from "../factory/createApp.js";
import type { ArcModuleInput } from "../factory/module/index.js";
import { getModuleExports } from "../factory/module/index.js";
import type { CreateAppOptions } from "../factory/types/index.js";

/** Handed to a modules factory — the in-memory DB is live at call time. */
/**
 * A provisioned test database — what the `database` seam yields. Arc
 * core never names a driver: kits ship factories (`mongoMemoryDatabase`
 * is the built-in default; a sqlitekit/pgkit testkit ships its own) and
 * the connection flows through as an opaque generic.
 */
export interface TestDatabase<TConn = unknown> {
  /** Connection string, when the backend has one (informational). */
  uri: string;
  /** Driver connection handle passed to the modules factory. */
  connection: TConn;
  /** Stop/disconnect everything this factory started. MUST be idempotent-safe to call once. */
  teardown(): Promise<void>;
}

/** The DB-provisioning seam — `bootModuleApp({ database })`. */
export type TestDatabaseFactory<TConn = unknown> = (opts: {
  replset?: boolean;
}) => Promise<TestDatabase<TConn>>;

export interface TestkitContext<TConn = unknown> {
  /** The provisioned database's connection string. */
  uri: string;
  /** @deprecated Alias of `uri` from the Mongo-default era — prefer `uri`. */
  mongoUri: string;
  /**
   * Driver connection handle (the default factory yields mongoose's
   * DEFAULT connection). Generic so DB-typed wrappers assert the driver
   * type ONCE: `bootModuleApp<Connection>(...)`. Arc core stays DB-agnostic.
   */
  connection: TConn;
}

export type BootModulesInput<TConn = unknown> =
  | ArcModuleInput
  | readonly ArcModuleInput[]
  | ((
      ctx: TestkitContext<TConn>,
    ) =>
      | ArcModuleInput
      | readonly ArcModuleInput[]
      | Promise<ArcModuleInput | readonly ArcModuleInput[]>);

export interface BootModuleAppOptions<TConn = unknown> {
  /**
   * DB provisioner. Default: `mongoMemoryDatabase` (in-memory MongoDB —
   * lazy devDep imports, nothing Mongo touches arc's runtime). Kits for
   * other stores inject their own factory here; the rest of the harness
   * (module resolution, app boot, teardown ordering) is DB-agnostic.
   */
  database?: TestDatabaseFactory<TConn>;
  /** Single-node replica set (transactions). Default: standalone. Passed to the database factory. */
  replset?: boolean;
  /**
   * Extra `createApp` options merged over the testing defaults
   * (`preset: 'testing'`, `auth: false`, `sensible: false` — utility
   * plugins stay off so the testkit is dependency-light; re-enable per
   * boot when a module genuinely exercises one).
   */
  app?: Partial<CreateAppOptions>;
}

export interface ModuleTestApp<TConn = unknown> {
  app: FastifyInstance;
  /** The provisioned database's connection string. */
  uri: string;
  /** @deprecated Alias of `uri` from the Mongo-default era — prefer `uri`. */
  mongoUri: string;
  /** The mongoose `Connection` handed to the modules factory. */
  connection: TConn;
  /**
   * Typed module-export accessor — `t.exports<CatalogEngine>('catalog')`
   * instead of reaching through `(t.app as ...).arc.modules.catalog`.
   * Delegates to `getModuleExports` (throws with the registered-module
   * list when the name is unknown — same contract hosts get).
   */
  exports<TExports = unknown>(name: string): TExports;
  /** Close app → disconnect mongoose → stop the in-memory server. Idempotent. */
  close(): Promise<void>;
}

/**
 * The built-in DB factory: in-memory MongoDB via lazy devDep imports.
 * Everything Mongo-specific about the harness lives HERE — the harness
 * itself is driver-blind and any kit can replace this via `database`.
 */
export async function mongoMemoryDatabase(opts: {
  replset?: boolean;
}): Promise<TestDatabase<unknown>> {
  let mms: typeof import("mongodb-memory-server");
  try {
    mms = await import("mongodb-memory-server");
  } catch {
    throw new Error(
      "[arc-testing] bootModuleApp's default database is in-memory MongoDB — install " +
        "'mongodb-memory-server' + 'mongoose' as devDependencies, or inject your own " +
        "`database` factory for a different store",
    );
  }
  const server = opts.replset
    ? await mms.MongoMemoryReplSet.create({ replSet: { count: 1 } })
    : await mms.MongoMemoryServer.create();
  const uri = server.getUri();

  // Own the DEFAULT connection — kernels and models register against it
  // (`mongoose.model()`, engines defaulting to `mongoose.connection`), so a
  // named `createConnection` would boot an app whose models point at a
  // different (unconnected) database. A prior suite's connection would leak
  // state (and mongoose models) across boots — disconnect first.
  const mongoose = (await import("mongoose")).default;
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(uri);
  // Owning the default connection includes its MODEL REGISTRY: models
  // persist across disconnect/connect, so a second boot in the same file
  // (e.g. testing a module's `only:` selector) would collide on every
  // kernel model ("model X already exists"). Each boot starts clean —
  // engines re-register their models during the factory anyway.
  mongoose.connection.deleteModel(/.*/);

  return {
    uri,
    connection: mongoose.connection,
    teardown: async () => {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect().catch(() => undefined);
      }
      await server.stop().catch(() => undefined);
    },
  };
}

export async function bootModuleApp<TConn = unknown>(
  modules: BootModulesInput<TConn>,
  options: BootModuleAppOptions<TConn> = {},
): Promise<ModuleTestApp<TConn>> {
  // Default: Mongo (arc's historical testing default). The cast is the one
  // documented boundary — the default factory's connection is mongoose's
  // default connection; DB-typed wrappers pin TConn themselves.
  const provision =
    options.database ?? (mongoMemoryDatabase as unknown as TestDatabaseFactory<TConn>);
  const db = await provision({ replset: options.replset ?? false });

  const ctx: TestkitContext<TConn> = {
    uri: db.uri,
    mongoUri: db.uri,
    connection: db.connection,
  };
  // A bare function is ALWAYS the context factory; thunks ride inside arrays.
  // Sync or ASYNC — engine creation is usually async, so factories are too.
  const resolved = typeof modules === "function" ? await modules(ctx) : modules;
  const list = Array.isArray(resolved) ? resolved : [resolved as ArcModuleInput];

  let app: FastifyInstance;
  try {
    app = await createApp({
      preset: "testing",
      auth: false,
      sensible: false,
      ...options.app,
      modules: list,
    });
    await app.ready();
  } catch (err) {
    // A throwing boot must not leave the DB running — hung test processes
    // are worse than the failure itself.
    await db.teardown().catch(() => undefined);
    throw err;
  }

  let closed = false;
  return {
    app,
    uri: db.uri,
    mongoUri: db.uri,
    connection: db.connection,
    exports: <TExports = unknown>(name: string) => getModuleExports<TExports>(app, name),
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close().catch(() => undefined);
      await db.teardown().catch(() => undefined);
    },
  };
}
