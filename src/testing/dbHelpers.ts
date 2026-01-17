/**
 * Testing Utilities - Database Helpers
 *
 * Utilities for managing test databases and fixtures
 */

import { beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { Connection } from 'mongoose';

/**
 * Test database manager
 */
export class TestDatabase {
  private connection?: Connection;
  private dbName: string;

  constructor(dbName: string = `test_${Date.now()}`) {
    this.dbName = dbName;
  }

  /**
   * Connect to test database
   */
  async connect(uri?: string): Promise<Connection> {
    const mongoUri = uri || process.env.MONGO_TEST_URI || 'mongodb://localhost:27017';
    const fullUri = `${mongoUri}/${this.dbName}`;

    this.connection = await mongoose.createConnection(fullUri).asPromise();
    return this.connection;
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.dropDatabase();
      await this.connection.close();
      this.connection = undefined;
    }
  }

  /**
   * Clear all collections
   */
  async clear(): Promise<void> {
    if (!this.connection?.db) {
      throw new Error('Database not connected');
    }

    const collections = await this.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
  }

  /**
   * Get connection
   */
  getConnection(): Connection {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    return this.connection;
  }
}

/**
 * Higher-order function to wrap tests with database setup/teardown
 *
 * @example
 * describe('Product Tests', () => {
 *   withTestDb(async (db) => {
 *     test('create product', async () => {
 *       const Product = db.getConnection().model('Product', schema);
 *       const product = await Product.create({ name: 'Test' });
 *       expect(product.name).toBe('Test');
 *     });
 *   });
 * });
 */
export function withTestDb(
  tests: (db: TestDatabase) => void | Promise<void>,
  options: { uri?: string; dbName?: string } = {}
): void {
  const db = new TestDatabase(options.dbName);

  beforeAll(async () => {
    await db.connect(options.uri);
  });

  afterAll(async () => {
    await db.disconnect();
  });

  afterEach(async () => {
    await db.clear();
  });

  tests(db);
}

/**
 * Create test fixtures
 *
 * @example
 * const fixtures = new TestFixtures(connection);
 *
 * await fixtures.load('products', [
 *   { name: 'Product 1', price: 100 },
 *   { name: 'Product 2', price: 200 },
 * ]);
 *
 * const products = await fixtures.get('products');
 */
export class TestFixtures {
  private fixtures: Map<string, any[]> = new Map();

  constructor(private connection: Connection) {}

  /**
   * Load fixtures into a collection
   */
  async load<T = any>(collectionName: string, data: Partial<T>[]): Promise<T[]> {
    const collection = this.connection.collection(collectionName);
    const result = await collection.insertMany(data as any[]);

    const insertedDocs = Object.values(result.insertedIds).map((id, index) => ({
      ...data[index],
      _id: id,
    })) as T[];

    this.fixtures.set(collectionName, insertedDocs);
    return insertedDocs;
  }

  /**
   * Get loaded fixtures
   */
  get<T = any>(collectionName: string): T[] {
    return (this.fixtures.get(collectionName) || []) as T[];
  }

  /**
   * Get first fixture
   */
  getFirst<T = any>(collectionName: string): T | null {
    const items = this.get<T>(collectionName);
    return items[0] || null;
  }

  /**
   * Clear all fixtures
   */
  async clear(): Promise<void> {
    for (const collectionName of this.fixtures.keys()) {
      const collection = this.connection.collection(collectionName);
      const ids = this.fixtures.get(collectionName)?.map((item) => item._id) || [];
      await collection.deleteMany({ _id: { $in: ids } });
    }
    this.fixtures.clear();
  }
}

/**
 * In-memory MongoDB for ultra-fast tests
 *
 * Requires: mongodb-memory-server
 *
 * @example
 * import { InMemoryDatabase } from '@classytic/arc/testing';
 *
 * describe('Fast Tests', () => {
 *   const memoryDb = new InMemoryDatabase();
 *
 *   beforeAll(async () => {
 *     await memoryDb.start();
 *   });
 *
 *   afterAll(async () => {
 *     await memoryDb.stop();
 *   });
 *
 *   test('create user', async () => {
 *     const uri = memoryDb.getUri();
 *     // Use uri for connection
 *   });
 * });
 */
export class InMemoryDatabase {
  private mongod?: any;
  private uri?: string;

  /**
   * Start in-memory MongoDB
   */
  async start(): Promise<string> {
    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      this.mongod = await MongoMemoryServer.create();
      const uri = this.mongod.getUri() as string;
      this.uri = uri;
      return uri;
    } catch {
      throw new Error(
        'mongodb-memory-server not installed. Install with: npm install -D mongodb-memory-server'
      );
    }
  }

  /**
   * Stop in-memory MongoDB
   */
  async stop(): Promise<void> {
    if (this.mongod) {
      await this.mongod.stop();
      this.mongod = undefined;
      this.uri = undefined;
    }
  }

  /**
   * Get connection URI
   */
  getUri(): string {
    if (!this.uri) {
      throw new Error('In-memory database not started');
    }
    return this.uri;
  }
}

/**
 * Database transaction helper for testing
 */
export class TestTransaction {
  private session?: any;

  constructor(private connection: Connection) {}

  /**
   * Start transaction
   */
  async start(): Promise<void> {
    this.session = await this.connection.startSession();
    this.session.startTransaction();
  }

  /**
   * Commit transaction
   */
  async commit(): Promise<void> {
    if (!this.session) {
      throw new Error('Transaction not started');
    }
    await this.session.commitTransaction();
    await this.session.endSession();
    this.session = undefined;
  }

  /**
   * Rollback transaction
   */
  async rollback(): Promise<void> {
    if (!this.session) {
      throw new Error('Transaction not started');
    }
    await this.session.abortTransaction();
    await this.session.endSession();
    this.session = undefined;
  }

  /**
   * Get session
   */
  getSession(): any {
    if (!this.session) {
      throw new Error('Transaction not started');
    }
    return this.session;
  }
}

/**
 * Seed data helper
 */
export class TestSeeder {
  constructor(private connection: Connection) {}

  /**
   * Seed collection with data
   */
  async seed<T>(collectionName: string, generator: () => T[], count: number = 10): Promise<T[]> {
    const data = Array.from({ length: count }, () => generator()).flat();
    const collection = this.connection.collection(collectionName);
    const result = await collection.insertMany(data as any[]);

    return Object.values(result.insertedIds).map((id, index) => ({
      ...data[index],
      _id: id,
    })) as T[];
  }

  /**
   * Clear collection
   */
  async clear(collectionName: string): Promise<void> {
    const collection = this.connection.collection(collectionName);
    await collection.deleteMany({});
  }

  /**
   * Clear all collections
   */
  async clearAll(): Promise<void> {
    if (!this.connection.db) {
      throw new Error('Database not connected');
    }
    const collections = await this.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
  }
}

/**
 * Database snapshot helper for rollback testing
 */
export class DatabaseSnapshot {
  private snapshots: Map<string, any[]> = new Map();

  constructor(private connection: Connection) {}

  /**
   * Take snapshot of current database state
   */
  async take(): Promise<void> {
    if (!this.connection.db) {
      throw new Error('Database not connected');
    }
    const collections = await this.connection.db.collections();

    for (const collection of collections) {
      const data = await collection.find({}).toArray();
      this.snapshots.set(collection.collectionName, data);
    }
  }

  /**
   * Restore database to snapshot
   */
  async restore(): Promise<void> {
    if (!this.connection.db) {
      throw new Error('Database not connected');
    }
    // Clear current data
    const collections = await this.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));

    // Restore snapshot
    for (const [collectionName, data] of this.snapshots.entries()) {
      if (data.length > 0) {
        const collection = this.connection.collection(collectionName);
        await collection.insertMany(data);
      }
    }
  }

  /**
   * Clear snapshot
   */
  clear(): void {
    this.snapshots.clear();
  }
}
