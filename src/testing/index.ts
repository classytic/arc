/**
 * @classytic/arc/testing — test utilities for arc apps
 *
 * Three primary entry points, picked by what you're testing:
 *
 *   1. HTTP behavior      → `createHttpTestHarness(resource, { app, auth, ... })`
 *      Auto-generates CRUD + permission + validation tests against a live app.
 *
 *   2. Custom scenarios   → `createTestApp({ resources, authMode, db })`
 *      Turnkey Fastify + in-memory Mongo + auth provider + fixture tracker.
 *      Use `ctx.app.inject()` and `expectArc(res)` for assertions.
 *
 *   3. Adapter contracts  → `runStorageContract(setup)`
 *      Verify a Storage implementation satisfies arc's adapter contract.
 *      DB-agnostic; no Mongoose assumption.
 *
 * Everything else (mocks, fixture builders, assertion helpers, auth sessions)
 * composes with one of the three above. See the docs for the decision tree:
 * [docs/testing/index.mdx](../../docs/testing/index.mdx).
 */

// --- Arc-specific assertions -----------------------------------------------
export type { ArcAssertion, ArcResponseLike } from "./assertions.js";
export { expectArc } from "./assertions.js";

// --- Auth sessions ----------------------------------------------------------
export type { RoleConfig, TestAuthProvider, TestAuthSession } from "./authSession.js";
export {
  createBetterAuthProvider,
  createCustomAuthProvider,
  createJwtAuthProvider,
} from "./authSession.js";

// --- Better Auth flow helpers (thin layer over TestAuthProvider) ------------
export type {
  AuthResponse,
  BetterAuthTestHelpers,
  BetterAuthTestHelpersOptions,
  BetterAuthTestUser,
  CreateOrgInput,
  OrgResponse,
  SetupBetterAuthTestAppInput,
  SetupBetterAuthTestAppResult,
  SignInInput,
  SignUpInput,
} from "./betterAuth.js";
export {
  createBetterAuthTestHelpers,
  safeParseBody,
  setupBetterAuthTestApp,
} from "./betterAuth.js";

// --- Fixtures ---------------------------------------------------------------
export type {
  FixtureDestroyer,
  FixtureFactory,
  FixtureRegistration,
  TestFixtures,
} from "./fixtures.js";
export { createTestFixtures } from "./fixtures.js";
// --- HTTP harness -----------------------------------------------------------
export type { HttpTestHarnessOptions } from "./HttpTestHarness.js";
export { createHttpTestHarness, HttpTestHarness } from "./HttpTestHarness.js";
// --- Mocks (repositories, users, requests, timers, spies) -------------------
export type { MockRepository } from "./mocks.js";
export {
  createDataFactory,
  createMockController,
  createMockReply,
  createMockRepository,
  createMockRequest,
  createMockUser,
  createSpy,
  createTestTimer,
  waitFor,
} from "./mocks.js";
// --- Vitest preload helper --------------------------------------------------
export { preloadResources, preloadResourcesAsync } from "./preloadResources.js";
// --- Storage adapter contract ----------------------------------------------
export type { StorageContractSetup, StorageContractSetupResult } from "./storageContract.js";
export { runStorageContract } from "./storageContract.js";
// --- Test app + lifecycle ---------------------------------------------------
export type { AuthMode, CreateTestAppOptions, DbMode, TestAppContext } from "./testApp.js";
export { createMinimalTestApp, createTestApp } from "./testApp.js";
