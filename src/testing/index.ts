/**
 * Testing Module
 *
 * Test utilities for Arc resources.
 * Provides helpers for:
 * - spinning up test Fastify apps
 * - mocking repositories/controllers
 * - managing test databases (optional)
 * - generating baseline resource tests
 */

export type {
  AuthResponse,
  BetterAuthTestHelpers,
  BetterAuthTestHelpersOptions,
  OrgResponse,
  SetupBetterAuthOrgOptions,
  SetupUserConfig,
  TestOrgContext,
  TestUserContext,
} from "./authHelpers.js";
// Better Auth test helpers
export {
  createBetterAuthTestHelpers,
  safeParseBody,
  setupBetterAuthOrg,
} from "./authHelpers.js";
// DB helpers (MongoDB/Mongoose) - optional
export {
  DatabaseSnapshot,
  InMemoryDatabase,
  TestDatabase,
  TestFixtures as DbTestFixtures,
  TestSeeder,
  TestTransaction,
  withTestDb,
} from "./dbHelpers.js";
export type {
  AuthProvider,
  HttpTestHarnessOptions,
} from "./HttpTestHarness.js";
// HTTP test harness
export {
  createBetterAuthProvider,
  createHttpTestHarness,
  createJwtAuthProvider,
  HttpTestHarness,
} from "./HttpTestHarness.js";
// Mock factories
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
// Vitest preload helpers (for resources that don't load via dynamic import)
export { preloadResources, preloadResourcesAsync } from "./preloadResources.js";
export type { StorageContractSetup, StorageContractSetupResult } from "./storageContract.js";
// Storage contract suite — verify Storage adapters for filesUploadPreset
export { runStorageContract } from "./storageContract.js";
export type { GenerateTestFileOptions, TestFixtures, TestHarnessOptions } from "./TestHarness.js";
export {
  createConfigTestSuite,
  createTestHarness,
  generateTestFile,
  TestHarness,
} from "./TestHarness.js";
export type { CreateTestAppOptions, TestAppResult } from "./testFactory.js";
// App factory + request helpers
export {
  createMinimalTestApp,
  createSnapshotMatcher,
  createTestApp,
  createTestAuth,
  request,
  TestDataLoader,
  TestRequestBuilder,
} from "./testFactory.js";
