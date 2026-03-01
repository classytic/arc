# Arc Framework Test Suite

Comprehensive end-to-end and unit tests for the Arc framework using Vitest.

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage report
npm run test:coverage

# Run only E2E tests
npm run test:e2e

# Run only unit tests
npm run test:unit

# Run with UI
npm run test:ui
```

## Test Structure

```
tests/
├── setup.ts                    # Test utilities and helpers
├── core/
│   └── base-controller.test.ts # CRUD operations and hooks
├── hooks/
│   └── hook-system.test.ts     # Hook registration and execution
├── utils/
│   └── circuit-breaker.test.ts # Circuit breaker pattern
└── e2e/
    └── full-app.test.ts        # Complete integration tests
```

## Test Coverage

### Core Module (✅ Implemented)
- **BaseController** - All CRUD operations (create, update, delete, getById, getAll)
- **Hook Integration** - beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete
- **Hook Priority** - Execution order based on priority
- **Error Handling** - Before hooks fail request, after hooks log errors
- **Query Features** - Filtering, sorting, pagination

### Hooks Module (✅ Implemented)
- **Registration** - Both object and positional argument syntax
- **Execution** - Before and after hooks with data transformation
- **Priority** - Lower priority executes first
- **Wildcards** - Wildcard hooks for all resources
- **Unregistration** - Cleanup and removal
- **Error Handling** - After hooks don't fail requests

### Utils Module (✅ Implemented)
- **Circuit Breaker** - CLOSED/OPEN/HALF_OPEN state transitions
- **Fallbacks** - Graceful degradation when circuit is open
- **Timeouts** - Long-running operation protection
- **Statistics** - Success/failure tracking
- **Manual Control** - Manual reset and state inspection

### E2E Tests (✅ Implemented)
- **Full Application** - Factory initialization to HTTP requests
- **Health Checks** - Liveness and readiness endpoints
- **CRUD Flow** - Complete create → read → update → delete flow
- **Hook Execution** - Lifecycle hooks executing in real requests
- **Query Features** - Filtering, sorting, pagination in HTTP layer
- **Error Handling** - 404s, validation errors, server errors

## Test Utilities

### `setupTestDatabase()`
Creates a MongoDB Memory Server for isolated testing.

```typescript
import { setupTestDatabase, teardownTestDatabase } from './setup.js';

beforeAll(async () => {
  const mongoUri = await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});
```

### `createMockModel(name)`
Creates a Mongoose model for testing.

```typescript
import { createMockModel } from './setup.js';

const Product = createMockModel('Product');
const repository = new BaseRepository(Product);
```

### `clearDatabase()`
Clears all collections between tests.

```typescript
import { clearDatabase } from './setup.js';

afterEach(async () => {
  await clearDatabase();
});
```

### Mock Data
```typescript
import { mockUser, mockOrg, mockContext } from './setup.js';

const req = {
  user: mockUser,
  context: mockContext,
};
```

## Writing New Tests

### Unit Test Template

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupGlobalHooks } from '../setup.js';

setupGlobalHooks(); // Auto-setup/teardown database

describe('MyFeature', () => {
  beforeEach(() => {
    // Setup for each test
  });

  it('should do something', () => {
    expect(true).toBe(true);
  });
});
```

### E2E Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/factory/createApp.js';
import { setupTestDatabase, teardownTestDatabase } from '../setup.js';

describe('Feature E2E', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const mongoUri = await setupTestDatabase();
    app = await createApp({
      preset: 'development',
      auth: { type: 'jwt', jwt: { secret: 'test-jwt-secret-must-be-at-least-32-chars-long' } },
      logger: false,
    });
    await app.listen({ port: 3001 });
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase();
  });

  it('should handle request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/endpoint',
    });

    expect(response.statusCode).toBe(200);
  });
});
```

## Coverage Goals

- **Statements**: > 80%
- **Branches**: > 75%
- **Functions**: > 80%
- **Lines**: > 80%

## CI/CD Integration

Tests run automatically on:
- Pre-commit (via hooks)
- Pull requests
- Before publishing to npm

## Debugging Tests

```bash
# Run specific test file
npx vitest run tests/core/base-controller.test.ts

# Run tests matching pattern
npx vitest run -t "should create"

# Debug with inspect
node --inspect-brk ./node_modules/.bin/vitest run

# Use console.log or debugger
it('should debug', () => {
  console.log('Debug info');
  debugger; // Set breakpoint
});
```

## Known Issues

- MongoDB Memory Server can be slow on first run (downloads binary)
- Some tests may timeout on slow machines (increase `testTimeout` in vitest.config.ts)
- Ensure MongoDB is not running on port 27017 (conflicts with memory server)

### Cache Module (✅ Implemented)
- **QueryCache** — get/set, SWR freshness, version bumping
- **Cache Keys** — deterministic key generation, param hashing
- **Tag Versions** — cross-resource tag invalidation

## Future Tests

Tests we should add:
- [ ] Presets (softDelete, slugLookup, multiTenant, ownedByUser)
- [ ] Health plugin (Prometheus metrics, readiness checks)
- [ ] Tracing plugin (OpenTelemetry spans)
- [ ] Schema migrations (up, down, validation)
- [ ] Factory presets (production, development, testing)
- [ ] Authentication/Authorization
- [ ] Organization scoping
- [ ] Events system
- [ ] Policies
- [ ] OpenAPI documentation generation
