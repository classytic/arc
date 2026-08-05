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
// --- Authorization conformance (cross-surface enforcement parity) -----------
export type {
  AuthorizationConformance,
  SurfaceObservation,
} from "./authorizationConformance.js";
export { runAuthorizationConformance } from "./authorizationConformance.js";
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
// --- Module composability harness (2.22) -------------------------------------
export type {
  BootModuleAppOptions,
  BootModulesInput,
  ModuleTestApp,
  TestDatabase,
  TestDatabaseFactory,
  TestkitContext,
} from "./bootModuleApp.js";
export { bootModuleApp, mongoMemoryDatabase } from "./bootModuleApp.js";
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
/**
 * Setup context for tests that call a module's phases directly — collects the
 * disposers a no-op `{ defer: () => {} }` would silently discard.
 */
export { createTestModuleSetup, type TestModuleSetup } from "./moduleSetup.js";
// --- Vitest preload helper --------------------------------------------------
export { preloadResources, preloadResourcesAsync } from "./preloadResources.js";
/** The ONE role gate for package tests — see its module docblock. */
export { scopeRoleGate } from "./scopeRoleGate.js";
// --- Storage adapter contract ----------------------------------------------
export type { StorageContractSetup, StorageContractSetupResult } from "./storageContract.js";
export { runStorageContract } from "./storageContract.js";
/**
 * Test-actor seam — how an injected request becomes somebody. Exported from the
 * TESTING entrypoint only; `createApp` never installs the hook, so a forged header
 * can never be identity in a real build.
 */
export {
  scopeFromTestActor,
  TEST_ACTOR_HEADER,
  type TestActor,
  testActorAuth,
  testActorHeaders,
} from "./testActor.js";
// --- Test app + lifecycle ---------------------------------------------------
export type { AuthMode, CreateTestAppOptions, DbMode, TestAppContext } from "./testApp.js";
export { createMinimalTestApp, createTestApp } from "./testApp.js";
