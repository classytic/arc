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

export { TestHarness, createTestHarness, generateTestFile } from './TestHarness.js';
export type { TestFixtures, TestHarnessOptions, GenerateTestFileOptions } from './TestHarness.js';

// App factory + request helpers
export {
  createTestApp,
  createMinimalTestApp,
  TestRequestBuilder,
  request,
  createTestAuth,
  createSnapshotMatcher,
  TestDataLoader,
} from './testFactory.js';
export type { CreateTestAppOptions, TestAppResult } from './testFactory.js';

// Mock factories
export {
  createMockRepository,
  createMockUser,
  createMockRequest,
  createMockReply,
  createMockController,
  createDataFactory,
  createSpy,
  waitFor,
  createTestTimer,
} from './mocks.js';

// DB helpers (MongoDB/Mongoose) - optional
export {
  TestDatabase,
  withTestDb,
  TestFixtures as DbTestFixtures,
  InMemoryDatabase,
  TestTransaction,
  TestSeeder,
  DatabaseSnapshot,
} from './dbHelpers.js';
