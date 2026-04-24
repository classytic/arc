/**
 * createTestApp — test app factory for arc
 *
 * One call spins up a Fastify instance with arc's standard test defaults,
 * an in-memory MongoDB (optional), an auth provider (JWT / Better Auth / none),
 * and a fixture tracker attached to the result. Every piece is optional —
 * tests that just need a vanilla app skip the extras.
 *
 *   const ctx = await createTestApp({
 *     resources: [jobResource],
 *     authMode: 'jwt',
 *   });
 *
 *   ctx.auth.register('admin', { user: { id: '1', roles: ['admin'] } });
 *   const admin = ctx.auth.as('admin');
 *   const res = await ctx.app.inject({ url: '/jobs', headers: admin.headers });
 *
 *   afterAll(() => ctx.close());
 *
 * Scope — what this factory does AND doesn't do:
 *   ✓ Starts in-memory Mongo (when `db: 'in-memory'`) and exposes `dbUri`
 *   ✓ Optionally connects Mongoose to that URI via `connectMongoose: true`
 *   ✓ Applies arc's standard test defaults for the Fastify instance
 *   ✓ Applies the matching auth plugin for the chosen `authMode`
 *   ✓ Registers every resource as a plugin (under its own `prefix`)
 *   ✓ Tears everything down in the right order on `close()`
 *   ✗ Does NOT thread `dbUri` into your resource adapters — adapter wiring
 *     (mongokit/prisma/sqlitekit/custom) is app-level concern. Call
 *     `mongoose.connect(ctx.dbUri)` (or use `connectMongoose: true`) before
 *     importing resources whose models need the connection.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ResourceDefinition } from "../core/defineResource.js";
import type { AuthOption, CreateAppOptions } from "../factory/types.js";
import {
  createBetterAuthProvider,
  createJwtAuthProvider,
  type TestAuthProvider,
} from "./authSession.js";
import { createTestFixtures, type TestFixtures } from "./fixtures.js";

// ============================================================================
// In-memory MongoDB — kept internal now that dbHelpers is gone.
// ============================================================================

interface InMemoryMongoHandle {
  uri: string;
  stop(): Promise<void>;
}

async function startInMemoryMongo(): Promise<InMemoryMongoHandle> {
  try {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    return {
      uri,
      async stop() {
        await mongod.stop();
      },
    };
  } catch (err) {
    throw new Error(
      `createTestApp({ db: 'in-memory' }): mongodb-memory-server is required. Install with \`npm i -D mongodb-memory-server\`. Root cause: ${(err as Error).message}`,
    );
  }
}

interface MongooseConnectionHandle {
  disconnect(): Promise<void>;
}

async function connectMongooseToUri(uri: string): Promise<MongooseConnectionHandle> {
  try {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(uri);
    return {
      async disconnect() {
        await mongoose.disconnect();
      },
    };
  } catch (err) {
    throw new Error(
      `createTestApp({ connectMongoose: true }): failed to connect Mongoose to ${uri}. Root cause: ${(err as Error).message}`,
    );
  }
}

// ============================================================================
// Types
// ============================================================================

export type DbMode =
  | "in-memory" // spin up MongoMemoryServer, tear down on close
  | { uri: string } // external Mongo URI (user owns lifecycle)
  | false; // no DB wiring (unit tests)

export type AuthMode = "jwt" | "better-auth" | "none";

export interface CreateTestAppOptions extends Partial<Omit<CreateAppOptions, "resources">> {
  /**
   * Resources to auto-register. Pass `defineResource` results directly —
   * createTestApp registers each as a Fastify plugin under their `prefix`.
   * For apps that need custom registration, use `plugins: async (f) => { ... }`
   * instead (standard createApp hook, passed through).
   */
  resources?: ReadonlyArray<ResourceDefinition<unknown>>;
  /**
   * Database mode:
   *   - `'in-memory'` (default) — boot a MongoMemoryServer, expose `dbUri`,
   *     tear down on `close()`. Requires `mongodb-memory-server`.
   *   - `{ uri }` — external Mongo URI; lifecycle is the caller's responsibility.
   *   - `false` — no DB wiring at all. Useful for pure Fastify unit tests.
   *
   * `dbUri` is returned on the context in every mode except `false`. Arc does
   * NOT automatically thread it into resource adapters — set
   * `connectMongoose: true` (Mongoose apps) or connect your adapter manually
   * before importing resources.
   */
  db?: DbMode;
  /**
   * When `true`, runs `mongoose.connect(dbUri)` before booting the Fastify
   * app and `mongoose.disconnect()` on `close()`. Turns the `db: 'in-memory'`
   * path into a one-liner for Mongoose-backed tests. Defaults to `false`.
   *
   * Non-Mongoose adapters (Prisma, sqlitekit, custom) should leave this
   * `false` and wire their own connection to `ctx.dbUri`.
   */
  connectMongoose?: boolean;
  /**
   * Auth mode attached to `ctx.auth` (and, for `'jwt'`, the default auth
   * plugin on the app):
   *
   *   - `'jwt'` (default) — provider signs tokens via `app.jwt.sign()`; the
   *     factory applies a default `auth: { type: 'jwt', jwt: {...} }` config
   *     UNLESS the caller supplies their own `auth` in options.
   *   - `'better-auth'` — provider uses pre-signed tokens you register.
   *     **No default auth config is applied** — the caller MUST pass their
   *     own `auth: { type: 'better-auth', ... }` via options, otherwise the
   *     app runs without an auth plugin and every request is unauthenticated.
   *     Mismatched `authMode: 'better-auth'` with a JWT-configured app would
   *     be a subtle bug (tests look like they pass but hit the wrong
   *     middleware), so we reject it at setup time.
   *   - `'none'` — no `ctx.auth` attached; no default auth config.
   */
  authMode?: AuthMode;
  /** Default org ID stamped on every session unless the role overrides. */
  defaultOrgId?: string;
}

export interface TestAppContext {
  app: FastifyInstance;
  /** Unified auth provider; `undefined` when `authMode: 'none'`. */
  auth: TestAuthProvider | undefined;
  /** Fixture tracker for record seeding. Always attached. */
  fixtures: TestFixtures;
  /** Connection URI — present when `db: 'in-memory'` or `{ uri }`. */
  dbUri?: string;
  /**
   * One cleanup for fixtures + app + Mongoose (if connected) + in-memory DB.
   * Idempotent.
   */
  close(): Promise<void>;
}

// ============================================================================
// Main factory
// ============================================================================

function pickDefaultAuth(
  authMode: AuthMode,
  callerAuth: AuthOption | undefined,
): AuthOption | undefined {
  // Caller-supplied `auth` always wins — nothing here overrides it.
  if (callerAuth !== undefined) return callerAuth;
  if (authMode === "jwt") {
    return { type: "jwt", jwt: { secret: "test-secret-32-chars-minimum-len" } };
  }
  // 'better-auth' and 'none' intentionally have NO default. Mismatched
  // combos (authMode: 'better-auth' + no caller-supplied auth config) are
  // flagged below so tests don't silently run against the wrong middleware.
  return undefined;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestAppContext> {
  const { createApp } = await import("../factory/createApp.js");

  const {
    resources = [],
    db = "in-memory",
    connectMongoose = false,
    authMode = "jwt",
    defaultOrgId,
    plugins,
    auth: callerAuth,
    ...appOptions
  } = options;

  // 1. DB — boot in-memory Mongo OR adopt an external URI.
  let dbHandle: InMemoryMongoHandle | undefined;
  let dbUri: string | undefined;
  if (db === "in-memory") {
    dbHandle = await startInMemoryMongo();
    dbUri = dbHandle.uri;
  } else if (db && typeof db === "object" && "uri" in db) {
    dbUri = db.uri;
  }

  // 1b. Optional Mongoose connect — the most common "turnkey" case for
  // Mongoose-backed resources. Runs BEFORE app boot so the resource
  // plugins' model lookups find an active connection.
  let mongooseHandle: MongooseConnectionHandle | undefined;
  if (connectMongoose) {
    if (!dbUri) {
      throw new Error(
        `createTestApp({ connectMongoose: true }): requires db: 'in-memory' or { uri }. Got db: ${JSON.stringify(db)}`,
      );
    }
    mongooseHandle = await connectMongooseToUri(dbUri);
  }

  // 2. Build the app via the canonical createApp path.
  //
  // The auth config selection is deliberate:
  //   - authMode: 'jwt' + no caller auth   → default JWT config (common case)
  //   - authMode: 'jwt' + caller auth      → caller wins (they know what they want)
  //   - authMode: 'better-auth' + no caller auth
  //       → FAIL FAST (would run JWT by accident and mask test errors)
  //   - authMode: 'better-auth' + caller auth  → caller wins
  //   - authMode: 'none' + caller auth     → caller wins
  //   - authMode: 'none' + no caller auth  → no auth plugin
  if (authMode === "better-auth" && callerAuth === undefined) {
    if (dbHandle) await dbHandle.stop();
    if (mongooseHandle) await mongooseHandle.disconnect();
    throw new Error(
      "createTestApp({ authMode: 'better-auth' }): you must also pass `auth: { type: 'better-auth', ... }`. " +
        "Without it the app has no auth plugin registered and tests would silently bypass Better Auth middleware.",
    );
  }

  const resolvedAuth = pickDefaultAuth(authMode, callerAuth);

  const testDefaults: Partial<CreateAppOptions> = {
    preset: "testing",
    logger: false,
    helmet: false,
    cors: false,
    rateLimit: false,
    underPressure: false,
    ...(resolvedAuth ? { auth: resolvedAuth } : {}),
  };

  const mergedPlugins = async (fastify: FastifyInstance): Promise<void> => {
    // Register user-supplied plugins first so their decorators are in
    // scope when resource plugins look them up.
    if (plugins) await plugins(fastify);
    for (const resource of resources) {
      await fastify.register(resource.toPlugin());
    }
  };

  const app = await createApp({
    ...testDefaults,
    ...appOptions,
    plugins: mergedPlugins,
  });

  // 3. Auth provider (test-session abstraction) — orthogonal to step 2's
  // auth plugin. `'better-auth'` here means "the provider uses pre-signed
  // tokens"; step 2 already confirmed the app is actually wired for Better
  // Auth.
  let auth: TestAuthProvider | undefined;
  if (authMode === "jwt") {
    auth = createJwtAuthProvider(app, { defaultOrgId });
  } else if (authMode === "better-auth") {
    auth = createBetterAuthProvider({ defaultOrgId });
  }

  // 4. Fixtures
  const fixtures = createTestFixtures();

  // 5. Cleanup — fixtures first (so their destroyers see a live DB), then
  //    app, then Mongoose, then in-memory Mongo.
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await fixtures.clear().catch(() => {
      /* non-fatal — we're tearing down anyway */
    });
    await app.close();
    if (mongooseHandle) await mongooseHandle.disconnect();
    if (dbHandle) await dbHandle.stop();
  };

  return { app, auth, fixtures, dbUri, close };
}

/**
 * Minimal Fastify instance — no arc plugins, no auth, no db. Use when a test
 * needs bare Fastify (e.g. plugin unit tests that manually register their
 * dependencies).
 */
export function createMinimalTestApp(options: FastifyServerOptions = {}): FastifyInstance {
  return Fastify({ logger: false, ...options });
}
