# Arc Testing Utilities

In-memory MongoDB, test app creation, mocks, data factories, and test harness.

## createTestApp()

Creates an isolated Fastify instance with in-memory MongoDB:

```bash
npm install -D mongodb-memory-server
```

```typescript
import { createTestApp } from '@classytic/arc/testing';
import type { TestAppResult } from '@classytic/arc/testing';

describe('API Tests', () => {
  let testApp: TestAppResult;

  beforeAll(async () => {
    testApp = await createTestApp({
      auth: { type: 'jwt', jwt: { secret: 'test-secret-32-chars-minimum-len' } },
      // All security plugins disabled by default in testing preset
    });

    // Connect models to in-memory DB
    await mongoose.connect(testApp.mongoUri);
  });

  afterAll(async () => {
    await testApp.close(); // Cleans up DB + closes app
  });

  test('GET /products', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/products',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });

  test('POST /products (authenticated)', async () => {
    const token = testApp.app.jwt.sign({ _id: 'user-1', roles: ['admin'] });

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/products',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Test Product', price: 99 },
    });
    expect(response.statusCode).toBe(201);
  });
});
```

### External MongoDB

```typescript
const testApp = await createTestApp({
  auth: { type: 'jwt', jwt: { secret: 'test-secret-32-chars-minimum-len' } },
  useInMemoryDb: false,
  mongoUri: 'mongodb://localhost:27017/test-db',
});
```

## TestHarness

Full lifecycle test helper — setup, fixtures, assertions, teardown:

```typescript
import { TestHarness } from '@classytic/arc/testing';

const harness = new TestHarness({
  auth: { type: 'jwt', jwt: { secret: 'test-secret-32-chars-minimum-len' } },
});

describe('Product API', () => {
  beforeAll(() => harness.setup());
  afterAll(() => harness.teardown());
  afterEach(() => harness.cleanup()); // Clear collections between tests

  test('full CRUD', async () => {
    // Create
    const created = await harness.inject('POST', '/products', {
      body: { name: 'Widget', price: 10 },
      auth: { _id: 'user-1', roles: ['admin'] },
    });
    expect(created.statusCode).toBe(201);

    // Read
    const fetched = await harness.inject('GET', `/products/${created.json().data._id}`);
    expect(fetched.json().data.name).toBe('Widget');

    // Update
    const updated = await harness.inject('PATCH', `/products/${created.json().data._id}`, {
      body: { price: 15 },
      auth: { _id: 'user-1', roles: ['admin'] },
    });
    expect(updated.json().data.price).toBe(15);

    // Delete
    const deleted = await harness.inject('DELETE', `/products/${created.json().data._id}`, {
      auth: { _id: 'user-1', roles: ['admin'] },
    });
    expect(deleted.statusCode).toBe(200);
  });
});
```

## Mock Repository

```typescript
import { createMockRepository } from '@classytic/arc/testing';

const mockRepo = createMockRepository({
  findById: jest.fn().mockResolvedValue({ _id: '123', name: 'Test' }),
  findAll: jest.fn().mockResolvedValue({ docs: [], total: 0 }),
  create: jest.fn().mockResolvedValue({ _id: '123', name: 'New' }),
  update: jest.fn().mockResolvedValue({ _id: '123', name: 'Updated' }),
  delete: jest.fn().mockResolvedValue(true),
});

// Use in tests
const controller = new ProductController(mockRepo);
```

## Data Factory

Generate test fixtures:

```typescript
import { createDataFactory } from '@classytic/arc/testing';

const productFactory = createDataFactory({
  name: (i) => `Product ${i}`,
  price: (i) => 100 + i * 10,
  isActive: () => true,
  category: () => 'electronics',
});

const product = productFactory.build();           // { name: 'Product 1', price: 110, ... }
const products = productFactory.buildMany(5);     // 5 products
const custom = productFactory.build({ price: 0 }); // Override specific fields
```

## Database Helpers

```typescript
import { withTestDb } from '@classytic/arc/testing';

describe('Repository', () => {
  withTestDb((db) => {
    // db.uri — MongoDB connection string
    // db.cleanup() — Clear all collections

    test('create and find', async () => {
      await mongoose.connect(db.uri);
      const product = await Product.create({ name: 'Test' });
      expect(product.name).toBe('Test');
    });
  });
});
```

## Testing Preset

When using `createTestApp()` or `createApp({ preset: 'testing' })`:

- Silent logging (no noise)
- No CORS restrictions
- Rate limiting disabled
- Minimal security overhead
- In-memory MongoDB (10x faster than external)
- No health monitoring

## Tips

1. **Use `app.inject()`** — No real HTTP, fastest possible
2. **Issue tokens via `app.jwt.sign()`** — Don't mock auth, test the real flow
3. **Use `afterEach` cleanup** — Clear collections between tests for isolation
4. **Use data factories** — Consistent, reproducible test data
5. **Test permissions** — Verify 401/403 responses with wrong/missing tokens
