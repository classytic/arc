/**
 * Test Setup and Helpers
 *
 * Common utilities for testing Arc framework
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import Fastify, { FastifyInstance } from 'fastify';
import { beforeAll, afterAll, afterEach } from 'vitest';

// Global MongoDB Memory Server
let mongoServer: MongoMemoryServer;

/**
 * Setup MongoDB Memory Server before all tests
 */
export async function setupTestDatabase(): Promise<string> {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  return uri;
}

/**
 * Teardown MongoDB Memory Server after all tests
 */
export async function teardownTestDatabase(): Promise<void> {
  await mongoose.disconnect();
  await mongoServer.stop();
}

/**
 * Clear all collections between tests
 */
export async function clearDatabase(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

/**
 * Create a test Fastify instance
 */
export function createTestFastify(): FastifyInstance {
  return Fastify({
    logger: false, // Disable logging in tests
  });
}

/**
 * Mock user for testing auth (using valid ObjectId)
 */
export const mockUser = {
  _id: '507f1f77bcf86cd799439011', // Valid ObjectId format
  email: 'test@example.com',
  roles: ['admin'],
};

/**
 * Mock organization for multi-tenant tests (using valid ObjectId)
 */
export const mockOrg = {
  _id: '507f1f77bcf86cd799439012', // Valid ObjectId format
  name: 'Test Organization',
  slug: 'test-org',
};

/**
 * Mock request context
 */
export const mockContext = {
  org: mockOrg,
  user: mockUser,
  requestId: 'test-request-123',
};

/**
 * Create a mock Mongoose model for testing
 */
export function createMockModel(name: string) {
  const schema = new mongoose.Schema(
    {
      name: String,
      description: String,
      price: Number,
      isActive: { type: Boolean, default: true },
      // Make these optional so tests don't fail
      createdBy: { type: mongoose.Schema.Types.ObjectId, required: false },
      organizationId: { type: mongoose.Schema.Types.ObjectId, required: false },
      deletedAt: Date,
      slug: String,
    },
    { timestamps: true }
  );

  // Check if model already exists (for test re-runs)
  if (mongoose.models[name]) {
    return mongoose.models[name];
  }

  return mongoose.model(name, schema);
}

/**
 * Wait for async operations to complete
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a repository for testing using the real MongoKit Repository
 */
export function createMockRepository(model: any) {
  // Import Repository from @classytic/mongokit
  const { Repository } = require('@classytic/mongokit');
  return new Repository(model);
}

/**
 * Global test hooks
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
