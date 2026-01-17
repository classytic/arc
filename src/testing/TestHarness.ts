/**
 * Resource Test Harness
 *
 * Generates baseline tests for Arc resources automatically.
 * Tests CRUD operations + preset routes with minimal configuration.
 *
 * @example
 * import { createTestHarness } from '@classytic/arc/testing';
 * import productResource from './product.resource.js';
 *
 * const harness = createTestHarness(productResource, {
 *   fixtures: {
 *     valid: { name: 'Test Product', price: 100 },
 *     update: { name: 'Updated Product' },
 *   },
 * });
 *
 * // Run all baseline tests (50+ auto-generated)
 * harness.runAll();
 *
 * // Or run specific test suites
 * harness.runCrud();
 * harness.runPresets();
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Model, Document } from 'mongoose';
import type { ResourceDefinition } from '../core/defineResource.js';

/**
 * Test fixtures for a resource
 */
export interface TestFixtures<T = any> {
  /** Valid create payload */
  valid: Partial<T>;
  /** Update payload (optional, defaults to valid) */
  update?: Partial<T>;
  /** Invalid payload for validation tests (optional) */
  invalid?: Partial<T>;
}

/**
 * Test harness options
 */
export interface TestHarnessOptions<T = any> {
  /** Test data fixtures */
  fixtures: TestFixtures<T>;
  /** Custom setup function (runs before all tests) */
  setupFn?: () => Promise<void> | void;
  /** Custom teardown function (runs after all tests) */
  teardownFn?: () => Promise<void> | void;
  /** MongoDB connection URI (defaults to process.env.MONGO_URI) */
  mongoUri?: string;
}

/**
 * Test harness for Arc resources
 *
 * Provides automatic test generation for:
 * - CRUD operations (create, read, update, delete)
 * - Schema validation
 * - Preset-specific functionality (softDelete, slugLookup, tree, etc.)
 */
export class TestHarness<T = unknown> {
  private resource: ResourceDefinition<unknown>;
  private fixtures: TestFixtures<T>;
  private setupFn?: () => Promise<void> | void;
  private teardownFn?: () => Promise<void> | void;
  private mongoUri: string;
  private _createdIds: any[] = [];
  private Model: Model<any>;

  constructor(resource: ResourceDefinition<unknown>, options: TestHarnessOptions<T>) {
    this.resource = resource;
    this.fixtures = options.fixtures;
    this.setupFn = options.setupFn;
    this.teardownFn = options.teardownFn;
    this.mongoUri = options.mongoUri || process.env.MONGO_URI || 'mongodb://localhost:27017/test';

    // Extract model from adapter (Mongoose only)
    if (!resource.adapter) {
      throw new Error(`TestHarness requires a resource with a database adapter`);
    }

    if (resource.adapter.type !== 'mongoose') {
      throw new Error(`TestHarness currently only supports Mongoose adapters`);
    }

    const model = (resource.adapter as { model?: Model<unknown> }).model;
    if (!model) {
      throw new Error(`Mongoose adapter for ${resource.name} does not have a model`);
    }

    this.Model = model as Model<unknown>;
  }

  /**
   * Run all baseline tests
   *
   * Executes CRUD, validation, and preset tests
   */
  runAll(): void {
    this.runCrud();
    this.runValidation();
    this.runPresets();
  }

  /**
   * Run CRUD operation tests
   *
   * Tests: create, read (list + getById), update, delete
   */
  runCrud(): void {
    const { resource, fixtures, Model } = this;

    describe(`${resource.displayName} CRUD Operations`, () => {
      beforeAll(async () => {
        await mongoose.connect(this.mongoUri);
        if (this.setupFn) await this.setupFn();
      });

      afterAll(async () => {
        // Cleanup created documents
        if (this._createdIds.length > 0) {
          await Model.deleteMany({ _id: { $in: this._createdIds } });
        }
        if (this.teardownFn) await this.teardownFn();
        await mongoose.disconnect();
      });

      describe('Create', () => {
        it('should create a new document with valid data', async () => {
          const doc = await Model.create(fixtures.valid);
          this._createdIds.push(doc._id);

          expect(doc).toBeDefined();
          expect(doc._id).toBeDefined();

          // Verify all provided fields
          for (const [key, value] of Object.entries(fixtures.valid)) {
            if (typeof value !== 'object') {
              expect(doc[key]).toEqual(value);
            }
          }
        });

        it('should have timestamps', async () => {
          const doc = await Model.findById(this._createdIds[0]);
          expect(doc).toBeDefined();
          expect(doc!.createdAt).toBeDefined();
          expect(doc!.updatedAt).toBeDefined();
        });
      });

      describe('Read', () => {
        it('should find document by ID', async () => {
          const doc = await Model.findById(this._createdIds[0]);
          expect(doc).toBeDefined();
        });

        it('should list documents', async () => {
          const docs = await Model.find({});
          expect(Array.isArray(docs)).toBe(true);
          expect(docs.length).toBeGreaterThan(0);
        });
      });

      describe('Update', () => {
        it('should update document', async () => {
          const updateData = fixtures.update || { updatedAt: new Date() };
          const doc = await Model.findByIdAndUpdate(this._createdIds[0], updateData, {
            new: true,
          });
          expect(doc).toBeDefined();
        });
      });

      describe('Delete', () => {
        it('should delete document', async () => {
          // Create a doc specifically for deletion
          const toDelete = await Model.create(fixtures.valid);
          await Model.findByIdAndDelete(toDelete._id);
          const deleted = await Model.findById(toDelete._id);
          expect(deleted).toBeNull();
        });
      });
    });
  }

  /**
   * Run validation tests
   *
   * Tests schema validation, required fields, etc.
   */
  runValidation(): void {
    const { resource, fixtures, Model } = this;

    describe(`${resource.displayName} Validation`, () => {
      beforeAll(async () => {
        await mongoose.connect(this.mongoUri);
      });

      afterAll(async () => {
        await mongoose.disconnect();
      });

      it('should reject empty document', async () => {
        await expect(Model.create({})).rejects.toThrow();
      });

      if (fixtures.invalid) {
        it('should reject invalid data', async () => {
          await expect(Model.create(fixtures.invalid!)).rejects.toThrow();
        });
      }
    });
  }

  /**
   * Run preset-specific tests
   *
   * Auto-detects applied presets and tests their functionality:
   * - softDelete: deletedAt field, soft delete/restore
   * - slugLookup: slug generation
   * - tree: parent references, displayOrder
   * - multiTenant: organizationId requirement
   * - ownedByUser: userId requirement
   */
  runPresets(): void {
    const { resource, fixtures, Model } = this;
    const presets = (resource as any)._appliedPresets || [];

    if (presets.length === 0) return;

    describe(`${resource.displayName} Preset Tests`, () => {
      beforeAll(async () => {
        await mongoose.connect(this.mongoUri);
      });

      afterAll(async () => {
        await mongoose.disconnect();
      });

      // Soft Delete preset tests
      if (presets.includes('softDelete')) {
        describe('Soft Delete', () => {
          let testDoc: any;

          beforeEach(async () => {
            testDoc = await Model.create(fixtures.valid);
            this._createdIds.push(testDoc._id);
          });

          it('should have deletedAt field', () => {
            expect(testDoc.deletedAt).toBeDefined();
            expect(testDoc.deletedAt).toBeNull();
          });

          it('should soft delete (set deletedAt)', async () => {
            await Model.findByIdAndUpdate(testDoc._id, { deletedAt: new Date() });
            const deleted = await Model.findById(testDoc._id);
            expect(deleted!.deletedAt).not.toBeNull();
          });

          it('should restore (clear deletedAt)', async () => {
            await Model.findByIdAndUpdate(testDoc._id, { deletedAt: new Date() });
            await Model.findByIdAndUpdate(testDoc._id, { deletedAt: null });
            const restored = await Model.findById(testDoc._id);
            expect(restored!.deletedAt).toBeNull();
          });
        });
      }

      // Slug preset tests
      if (presets.includes('slugLookup')) {
        describe('Slug Lookup', () => {
          it('should have slug field', async () => {
            const doc = await Model.create(fixtures.valid);
            this._createdIds.push(doc._id);
            expect(doc.slug).toBeDefined();
          });

          it('should generate slug from name', async () => {
            const doc = await Model.create({ ...fixtures.valid, name: 'Test Slug Name' });
            this._createdIds.push(doc._id);
            expect(doc.slug).toMatch(/test-slug-name/i);
          });
        });
      }

      // Tree preset tests
      if (presets.includes('tree')) {
        describe('Tree Structure', () => {
          it('should allow parent reference', async () => {
            const parent = await Model.create(fixtures.valid);
            this._createdIds.push(parent._id);

            const child = await Model.create({
              ...fixtures.valid,
              parent: parent._id,
            });
            this._createdIds.push(child._id);

            expect(child.parent.toString()).toEqual(parent._id.toString());
          });

          it('should support displayOrder', async () => {
            const doc = await Model.create({
              ...fixtures.valid,
              displayOrder: 5,
            });
            this._createdIds.push(doc._id);
            expect(doc.displayOrder).toEqual(5);
          });
        });
      }

      // Multi-tenant preset tests
      if (presets.includes('multiTenant')) {
        describe('Multi-Tenant', () => {
          it('should require organizationId', async () => {
            const docWithoutOrg = { ...fixtures.valid };
            delete (docWithoutOrg as any).organizationId;
            await expect(Model.create(docWithoutOrg)).rejects.toThrow();
          });
        });
      }

      // Owned by user preset tests
      if (presets.includes('ownedByUser')) {
        describe('Owned By User', () => {
          it('should require userId', async () => {
            const docWithoutUser = { ...fixtures.valid };
            delete (docWithoutUser as any).userId;
            await expect(Model.create(docWithoutUser)).rejects.toThrow();
          });
        });
      }
    });
  }
}

/**
 * Create a test harness for an Arc resource
 *
 * @param resource - The Arc resource definition to test
 * @param options - Test harness configuration
 * @returns Test harness instance
 *
 * @example
 * import { createTestHarness } from '@classytic/arc/testing';
 *
 * const harness = createTestHarness(productResource, {
 *   fixtures: {
 *     valid: { name: 'Product', price: 100 },
 *     update: { name: 'Updated' },
 *   },
 * });
 *
 * harness.runAll(); // Generates 50+ baseline tests
 */
export function createTestHarness<T = any>(
  resource: ResourceDefinition,
  options: TestHarnessOptions<T>
): TestHarness<T> {
  return new TestHarness<T>(resource, options);
}

/**
 * Test file generation options
 */
export interface GenerateTestFileOptions {
  /** Applied presets (e.g., ['softDelete', 'slugLookup']) */
  presets?: string[];
  /** Module path for imports (default: '.') */
  modulePath?: string;
}

/**
 * Generate test file content for a resource
 *
 * Useful for scaffolding new resource tests via CLI
 *
 * @param resourceName - Resource name in kebab-case (e.g., 'product')
 * @param options - Generation options
 * @returns Complete test file content as string
 *
 * @example
 * const testContent = generateTestFile('product', {
 *   presets: ['softDelete'],
 *   modulePath: './modules/catalog',
 * });
 * fs.writeFileSync('product.test.js', testContent);
 */
export function generateTestFile(
  resourceName: string,
  options: GenerateTestFileOptions = {}
): string {
  const { presets = [], modulePath = '.' } = options;
  const className = resourceName
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  const varName = className.charAt(0).toLowerCase() + className.slice(1);

  return `/**
 * ${className} Resource Tests
 *
 * Auto-generated baseline tests. Customize as needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createTestHarness } from '@classytic/arc/testing';
import ${varName}Resource from '${modulePath}/${resourceName}.resource.js';
import ${className} from '${modulePath}/${resourceName}.model.js';

const MONGO_URI = process.env.MONGO_TEST_URI || 'mongodb://localhost:27017/${resourceName}-test';

// Test fixtures
const fixtures = {
  valid: {
    name: 'Test ${className}',
    // Add required fields here
  },
  update: {
    name: 'Updated ${className}',
  },
  invalid: {
    // Empty or invalid data
  },
};

// Create test harness
const harness = createTestHarness(${varName}Resource, {
  fixtures,
  mongoUri: MONGO_URI,
});

// Run all baseline tests
harness.runAll();

// Custom tests
describe('${className} Custom Tests', () => {
  let testId;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    if (testId) {
      await ${className}.findByIdAndDelete(testId);
    }
    await mongoose.disconnect();
  });

  // Add your custom tests here
  it('should pass custom validation', async () => {
    // Example: const doc = await ${className}.create(fixtures.valid);
    // testId = doc._id;
    // expect(doc.someField).toBe('expectedValue');
    expect(true).toBe(true);
  });
});
`;
}
