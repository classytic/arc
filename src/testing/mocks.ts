/**
 * Testing Utilities - Mock Factories
 *
 * Create mock repositories, controllers, and services for testing.
 * Uses Vitest for mocking (compatible with Jest API).
 */

import type { OffsetPaginationResult } from "@classytic/repo-core/pagination";
import type { StandardRepo } from "@classytic/repo-core/repository";
import { type Mock, vi } from "vitest";
import type { AnyRecord } from "../types/index.js";

/**
 * Extended repository interface for testing (includes optional preset methods)
 */
export interface MockRepository<T> extends StandardRepo<T> {
  // Optional preset methods for testing
  getBySlug?: Mock;
  getDeleted?: Mock;
  restore?: Mock;
  getTree?: Mock;
  getChildren?: Mock;
  [key: string]: unknown;
}

/**
 * Create a mock repository for testing
 *
 * @example
 * const mockRepo = createMockRepository<Product>({
 *   getById: vi.fn().mockResolvedValue({ id: '1', name: 'Test' }),
 *   create: vi.fn().mockImplementation(data => Promise.resolve({ id: '1', ...data })),
 * });
 *
 * await mockRepo.getById('1'); // Returns mocked product
 */
export function createMockRepository<T extends AnyRecord = AnyRecord>(
  overrides: Partial<MockRepository<T>> = {},
): MockRepository<T> {
  const defaultMock: MockRepository<T> = {
    // MongoKit-compatible CRUD methods
    getAll: vi.fn().mockResolvedValue({
      method: "offset",
      docs: [],
      total: 0,
      page: 1,
      limit: 20,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    } as unknown as OffsetPaginationResult<T>),

    getById: vi.fn().mockResolvedValue(null),

    create: vi
      .fn()
      .mockImplementation((data: Partial<T>) =>
        Promise.resolve({ _id: "mock-id", ...data } as unknown as T),
      ),

    update: vi
      .fn()
      .mockImplementation((_id: string, data: Partial<T>) =>
        Promise.resolve({ _id: "mock-id", ...data } as unknown as T),
      ),

    delete: vi.fn().mockResolvedValue({ success: true, message: "Deleted" }),

    // Optional preset methods
    getBySlug: vi.fn().mockResolvedValue(null),
    getDeleted: vi.fn().mockResolvedValue([]),
    restore: vi.fn().mockResolvedValue(null),
    getTree: vi.fn().mockResolvedValue([]),
    getChildren: vi.fn().mockResolvedValue([]),

    // Apply overrides
    ...overrides,
  };

  return defaultMock;
}

/**
 * Create a mock user for authentication testing
 */
export function createMockUser(overrides: Partial<AnyRecord> = {}) {
  return {
    _id: "mock-user-id",
    id: "mock-user-id",
    email: "test@example.com",
    roles: ["user"],
    organizationId: null,
    ...overrides,
  };
}

/**
 * Create a mock Fastify request
 */
export function createMockRequest(overrides: Partial<AnyRecord> = {}) {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    user: createMockUser(),
    context: {},
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  } as unknown;
}

/**
 * Create a mock Fastify reply
 */
export function createMockReply() {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    headers: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    callNotFound: vi.fn().mockReturnThis(),
    sent: false,
  };

  return reply as unknown;
}

/**
 * Create a mock controller for testing
 */
export function createMockController(repository: StandardRepo<AnyRecord>) {
  return {
    repository,
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

/**
 * Create mock data factory
 *
 * @example
 * const productFactory = createDataFactory<Product>({
 *   name: () => faker.commerce.productName(),
 *   price: () => faker.number.int({ min: 10, max: 1000 }),
 *   sku: (i) => `SKU-${i}`,
 * });
 *
 * const product = productFactory.build();
 * const products = productFactory.buildMany(10);
 */
export function createDataFactory<T extends AnyRecord>(
  template: Record<keyof T, (index: number) => unknown>,
) {
  let counter = 0;

  return {
    build(overrides: Partial<T> = {}): T {
      const index = counter++;
      const data = {} as T;

      for (const [key, generator] of Object.entries(template)) {
        (data as AnyRecord)[key] = generator(index);
      }

      return { ...data, ...overrides };
    },

    buildMany(count: number, overrides: Partial<T> = {}): T[] {
      return Array.from({ length: count }, () => this.build(overrides));
    },

    reset() {
      counter = 0;
    },
  };
}

/**
 * Create a spy that tracks function calls
 *
 * Useful for testing side effects without full mocking
 */
export function createSpy<T extends (...args: unknown[]) => unknown>(
  _name = "spy",
): Mock<T> & { getCalls(): unknown[][]; getLastCall(): unknown[] } {
  const calls: unknown[][] = [];

  const spy = vi.fn((...args: unknown[]) => {
    calls.push(args);
  }) as Mock<T> & { getCalls(): unknown[][]; getLastCall(): unknown[] };

  spy.getCalls = () => calls;
  spy.getLastCall = () => calls[calls.length - 1] || [];

  return spy;
}

/**
 * Wait for a condition to be true
 *
 * Useful for async testing
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Create a test timer that can be controlled
 */
export function createTestTimer() {
  let time = Date.now();

  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    set: (timestamp: number) => {
      time = timestamp;
    },
    reset: () => {
      time = Date.now();
    },
  };
}
