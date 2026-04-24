/**
 * tests/setup.ts — shared test bootstrap
 *
 * Thin convenience layer over `@classytic/arc/testing` so the 40+ existing
 * unit/integration tests get the new public surface transparently. The
 * exported names match what those tests already import (`setupTestDatabase`,
 * `createMockModel`, `createMockRepository`, `mockUser`, `mockOrg`,
 * `setupGlobalHooks`), but the implementation now lives on top of
 * `createTestFixtures` / `createMockRepository` from the public API.
 *
 * New tests should prefer the public API directly:
 *
 *   import {
 *     createTestApp,
 *     createTestFixtures,
 *     expectArc,
 *   } from '@classytic/arc/testing';
 *
 *   const ctx = await createTestApp({ resources: [myResource] });
 *   ctx.auth.register('admin', { user: { id: '1', roles: ['admin'] } });
 *   const res = await ctx.app.inject({ url: '/things', headers: ctx.auth.as('admin').headers });
 *   expectArc(res).ok().hasData();
 */

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  createMockRepository as createArcMockRepository,
  createMockUser as createArcMockUser,
} from "../src/testing/mocks.js";

// ============================================================================
// Mongo lifecycle (shared across the arc test suite)
//
// Arc's own tests bind to Mongoose because every adapter-free unit test
// lands through `tests/setup.ts`. The public `createTestApp({ db:
// 'in-memory' })` factory is what apps built on arc use — we keep this
// file focused on the internal pattern so existing tests keep working.
// ============================================================================

let mongoServer: MongoMemoryServer | undefined;

export async function setupTestDatabase(): Promise<string> {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  return uri;
}

export async function teardownTestDatabase(): Promise<void> {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = undefined;
  }
}

export async function clearDatabase(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key]!.deleteMany({});
  }
}

// ============================================================================
// Mock values
// ============================================================================

export const mockUser = createArcMockUser({
  _id: "507f1f77bcf86cd799439011",
  id: "507f1f77bcf86cd799439011",
  email: "test@example.com",
  role: ["admin"],
});

export const mockOrg = {
  _id: "507f1f77bcf86cd799439012",
  name: "Test Organization",
  slug: "test-org",
};

export const mockContext = {
  org: mockOrg,
  user: mockUser,
  requestId: "test-request-123",
};

// ============================================================================
// Mongoose model + repository helpers (used by ~40 internal tests)
// ============================================================================

/**
 * Create a Mongoose test model with the default "generic document" schema
 * used across arc's unit tests. Re-registration is safe — the mongoose
 * compiled-model cache is checked first.
 */
export function createMockModel(name: string): mongoose.Model<unknown> {
  if (mongoose.models[name]) {
    return mongoose.models[name];
  }
  const schema = new mongoose.Schema(
    {
      name: String,
      description: String,
      price: Number,
      isActive: { type: Boolean, default: true },
      createdBy: { type: mongoose.Schema.Types.ObjectId, required: false },
      organizationId: { type: mongoose.Schema.Types.ObjectId, required: false },
      deletedAt: Date,
      slug: String,
    },
    { timestamps: true },
  );
  return mongoose.model(name, schema);
}

/**
 * Create a real `@classytic/mongokit` Repository against the given Mongoose
 * model. Tests that need a mock (no DB) use `createMockRepository` from
 * `@classytic/arc/testing` instead.
 */
export function createMockRepository(model: unknown): unknown {
  const { Repository } = require("@classytic/mongokit") as {
    Repository: new (model: unknown) => unknown;
  };
  return new Repository(model);
}

// Re-export arc's mock repository under the same name via a namespace for
// tests that want a pure mock instead of a live Mongo-backed repo.
export { createArcMockRepository as createMockRepositoryMock };

// ============================================================================
// Vitest wiring helpers
// ============================================================================

/**
 * Wire setup/teardown/clear into the current `describe` scope. Most arc
 * unit tests call this once at the top of the file; the three hooks below
 * keep fixtures and Mongoose state isolated per-test.
 */
export function setupGlobalHooks(): void {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await teardownTestDatabase();
  });
  afterEach(async () => {
    await clearDatabase();
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
