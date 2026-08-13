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
      data: [],
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

    // Required on `StandardRepo` as of repo-core 0.2.0 — both mongokit
    // 3.11+ and sqlitekit 0.1.1+ ship these as class primitives, so
    // mocks must provide a sensible default too (previously they were
    // optional and silently absent).
    updateMany: vi
      .fn()
      .mockResolvedValue({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }),

    deleteMany: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),

    // Required on `StandardRepo` as of repo-core 0.4 — both mongokit
    // 3.13+ and sqlitekit 0.3+ ship `claim` / `claimVersion` as class
    // primitives. The contract is non-optional (no `?`) so MockRepository
    // must provide a default that resolves to null (the canonical
    // race-loss / no-match signal).
    claim: vi.fn().mockResolvedValue(null),
    claimVersion: vi.fn().mockResolvedValue(null),

    // Required on `StandardRepo` as of repo-core 0.6 — kits declare what
    // they implement. The mock is honest: every flag is false because the
    // default mock ships none of those surfaces (no count/exists/distinct/
    // aggregate/transactions). Tests that mock such methods should override
    // `capabilities` alongside them.
    capabilities: {
      transactions: false,
      nestedTransactions: false,
      upsert: false,
      duplicateKeyError: false,
      distinct: false,
      aggregate: false,
      getOrCreate: false,
      countAndExists: false,
    },

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
 * Create a mock controller for testing.
 *
 * The return type is ANNOTATED rather than inferred, and writing it out IS the
 * fix: inference expands `Mock`'s default type argument to `Procedure`, which
 * vitest declares in an internal sub-package arc does not depend on. The
 * emitted declaration then referenced that package by name — resolvable under
 * npm's hoisting because `vitest` (a real peer) drags it in, and broken under
 * pnpm's strict layout, where a transitive dep is not reachable from a
 * consumer's root.
 *
 * Bare `Mock` keeps the permissive ergonomics (`.mockResolvedValue(...)`, any
 * arguments) while naming only `vitest`, which arc does declare. Same shape
 * `MockRepository` above uses.
 */
export function createMockController(repository: StandardRepo<AnyRecord>): {
  repository: StandardRepo<AnyRecord>;
  list: Mock;
  get: Mock;
  create: Mock;
  update: Mock;
  delete: Mock;
} {
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
 * Wait until `condition` holds — the standard way to assert on asynchronous
 * effects in arc's suites.
 *
 * **Prefer this over `await sleep(n)` + assert.** A fixed delay encodes a guess
 * about scheduling: too short and it flakes the moment the pool is busy, too
 * long and every run pays for the worst case. Polling returns as soon as the
 * effect lands, so the fast path stays fast and a loaded machine simply waits —
 * and the failure mode becomes "this never happened", which is the thing worth
 * asserting.
 *
 * Supply `label`: without it a timeout reports only its own duration, which is
 * the least useful sentence a flaky test can print.
 *
 * @example
 * await waitFor(() => runs >= 3, { label: "3 scheduler ticks" });
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  // 25ms rather than 100ms: polling is nearly free, while a coarse interval adds
  // up to its own length of latency to every wait that would have succeeded
  // immediately.
  const { timeout = 5000, interval = 25, label } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    label
      ? `Timed out after ${timeout}ms waiting for: ${label}`
      : `Timed out after ${timeout}ms waiting for a condition (pass "label" to name it)`,
  );
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
