/**
 * Testing Utilities - Test App Factory
 *
 * Create Fastify test instances with Arc configuration
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { CreateAppOptions } from "../factory/types.js";
import { InMemoryDatabase } from "./dbHelpers.js";

export interface CreateTestAppOptions extends Partial<CreateAppOptions> {
  /**
   * Use in-memory MongoDB for faster tests (default: true)
   * Requires: mongodb-memory-server
   *
   * Set to false to use a provided mongoUri instead
   */
  useInMemoryDb?: boolean;

  /**
   * MongoDB connection URI (only used if useInMemoryDb is false)
   */
  mongoUri?: string;
}

export interface TestAppResult {
  /** Fastify app instance */
  app: FastifyInstance;

  /**
   * Cleanup function to close app and disconnect database
   * Call this in afterAll() or afterEach()
   */
  close: () => Promise<void>;

  /** MongoDB connection URI (useful for connecting models) */
  mongoUri?: string;
}

/**
 * Create a test application instance with optional in-memory MongoDB
 *
 * **Performance Boost**: Uses in-memory MongoDB by default for 10x faster tests.
 *
 * @example Basic usage with in-memory DB
 * ```typescript
 * import { createTestApp } from '@classytic/arc/testing';
 *
 * describe('API Tests', () => {
 *   let testApp: TestAppResult;
 *
 *   beforeAll(async () => {
 *     testApp = await createTestApp({
 *       auth: { type: 'jwt', jwt: { secret: 'test-secret' } },
 *     });
 *   });
 *
 *   afterAll(async () => {
 *     await testApp.close(); // Cleans up DB and disconnects
 *   });
 *
 *   test('GET /health', async () => {
 *     const response = await testApp.app.inject({
 *       method: 'GET',
 *       url: '/health',
 *     });
 *     expect(response.statusCode).toBe(200);
 *   });
 * });
 * ```
 *
 * @example Using external MongoDB
 * ```typescript
 * const testApp = await createTestApp({
 *   auth: { type: 'jwt', jwt: { secret: 'test-secret' } },
 *   useInMemoryDb: false,
 *   mongoUri: 'mongodb://localhost:27017/test-db',
 * });
 * ```
 *
 * @example Accessing MongoDB URI for model connections
 * ```typescript
 * const testApp = await createTestApp({
 *   auth: { type: 'jwt', jwt: { secret: 'test-secret' } },
 * });
 * await mongoose.connect(testApp.mongoUri); // Connect your models
 * ```
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestAppResult> {
  const { createApp } = await import("../factory/createApp.js");
  const { useInMemoryDb = true, mongoUri: providedMongoUri, ...appOptions } = options;

  // Default auth config for tests
  const defaultAuth = { type: "jwt" as const, jwt: { secret: "test-secret-32-chars-minimum-len" } };

  let inMemoryDb: InMemoryDatabase | null = null;
  let mongoUri: string | undefined = providedMongoUri;

  // Start in-memory MongoDB if enabled and no URI provided
  if (useInMemoryDb && !providedMongoUri) {
    try {
      inMemoryDb = new InMemoryDatabase();
      mongoUri = await inMemoryDb.start();
    } catch (err) {
      console.warn(
        "[createTestApp] Failed to start in-memory MongoDB:",
        (err as Error).message,
        "\nFalling back to external MongoDB or no DB connection.",
      );
    }
  }

  const testDefaults: Partial<CreateAppOptions> = {
    preset: "testing",
    logger: false, // Disable logging in tests
    helmet: false,
    cors: false,
    rateLimit: false,
    underPressure: false,
    auth: defaultAuth,
  };

  const app = await createApp({
    ...testDefaults,
    ...appOptions, // User options override defaults (including auth)
  });

  // Return app with cleanup function
  return {
    app,
    mongoUri,
    async close() {
      await app.close();
      if (inMemoryDb) {
        await inMemoryDb.stop();
      }
    },
  };
}

/**
 * Create a minimal Fastify instance for unit tests
 *
 * Use when you don't need Arc's full plugin stack
 *
 * @example
 * const app = createMinimalTestApp();
 * app.get('/test', async () => ({ success: true }));
 *
 * const response = await app.inject({ method: 'GET', url: '/test' });
 * expect(response.json()).toEqual({ success: true });
 */
export function createMinimalTestApp(options: FastifyServerOptions = {}): FastifyInstance {
  return Fastify({
    logger: false,
    ...options,
  });
}

/**
 * Test request builder for cleaner tests
 *
 * @example
 * const request = new TestRequestBuilder(app)
 *   .get('/products')
 *   .withAuth(mockUser)
 *   .withQuery({ page: 1, limit: 10 });
 *
 * const response = await request.send();
 * expect(response.statusCode).toBe(200);
 */
export class TestRequestBuilder {
  private method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" = "GET";
  private url: string = "/";
  private body?: Record<string, unknown>;
  private query?: Record<string, string | string[]>;
  private headers: Record<string, string> = {};
  private app: FastifyInstance;

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  get(url: string) {
    this.method = "GET";
    this.url = url;
    return this;
  }

  post(url: string) {
    this.method = "POST";
    this.url = url;
    return this;
  }

  put(url: string) {
    this.method = "PUT";
    this.url = url;
    return this;
  }

  patch(url: string) {
    this.method = "PATCH";
    this.url = url;
    return this;
  }

  delete(url: string) {
    this.method = "DELETE";
    this.url = url;
    return this;
  }

  withBody(body: Record<string, unknown>) {
    this.body = body;
    return this;
  }

  withQuery(query: Record<string, string | string[]>) {
    this.query = query;
    return this;
  }

  withHeader(key: string, value: string) {
    this.headers[key] = value;
    return this;
  }

  withAuth(userOrHeaders: Record<string, unknown>) {
    if ("authorization" in userOrHeaders || "Authorization" in userOrHeaders) {
      // Pre-built headers (Better Auth tokens, external auth)
      for (const [key, value] of Object.entries(userOrHeaders)) {
        if (typeof value === "string") {
          this.headers[key] = value;
        }
      }
    } else {
      // JWT payload — sign with app's JWT plugin
      const token = this.app.jwt?.sign?.(userOrHeaders) || "mock-token";
      this.headers.Authorization = `Bearer ${token}`;
    }
    return this;
  }

  withContentType(type: string) {
    this.headers["Content-Type"] = type;
    return this;
  }

  async send() {
    return this.app.inject({
      method: this.method,
      url: this.url,
      payload: this.body,
      query: this.query,
      headers: this.headers,
    });
  }
}

/**
 * Helper to create a test request builder
 */
export function request(app: FastifyInstance) {
  return new TestRequestBuilder(app);
}

/**
 * Test helper for authentication
 */
export function createTestAuth(app: FastifyInstance) {
  return {
    /**
     * Generate a JWT token for testing
     */
    generateToken(user: Record<string, unknown>): string {
      if (!app.jwt) {
        throw new Error("JWT plugin not registered");
      }
      return app.jwt.sign(user);
    },

    /**
     * Decode a JWT token
     */
    decodeToken(token: string): Record<string, unknown> | null {
      if (!app.jwt) {
        throw new Error("JWT plugin not registered");
      }
      return app.jwt.decode(token);
    },

    /**
     * Verify a JWT token
     */
    async verifyToken(token: string): Promise<Record<string, unknown>> {
      if (!app.jwt) {
        throw new Error("JWT plugin not registered");
      }
      return app.jwt.verify(token);
    },
  };
}

/**
 * Snapshot testing helper for API responses
 */
export function createSnapshotMatcher() {
  return {
    /**
     * Match response structure (ignores dynamic values like timestamps)
     */
    matchStructure(response: unknown, expected: unknown): boolean {
      if (typeof response !== typeof expected) {
        return false;
      }

      if (Array.isArray(response) && Array.isArray(expected)) {
        return response.length === expected.length;
      }

      if (
        typeof response === "object" &&
        response !== null &&
        typeof expected === "object" &&
        expected !== null
      ) {
        const r = response as Record<string, unknown>;
        const e = expected as Record<string, unknown>;
        const responseKeys = Object.keys(r).sort();
        const expectedKeys = Object.keys(e).sort();

        if (JSON.stringify(responseKeys) !== JSON.stringify(expectedKeys)) {
          return false;
        }

        for (const key of responseKeys) {
          if (!this.matchStructure(r[key], e[key])) {
            return false;
          }
        }

        return true;
      }

      return true; // Primitives - don't compare values
    },
  };
}

/**
 * Bulk test data loader
 */
export class TestDataLoader {
  private data: Map<string, unknown[]> = new Map();

  /**
   * Load test data into database
   */
  async load(collection: string, items: Record<string, unknown>[]) {
    // Store for cleanup
    this.data.set(collection, items);

    // Load into database (assumes mongoose/mongodb)
    // This is a placeholder - implement based on your DB setup
    return items;
  }

  /**
   * Clear all loaded test data
   */
  async cleanup() {
    for (const [_collection, _items] of this.data.entries()) {
      // Cleanup logic here
      // e.g., await Model.deleteMany({ _id: { $in: items.map(i => i._id) } })
    }
    this.data.clear();
  }
}
