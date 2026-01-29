# Tree-Shaking & Import Best Practices

Arc is designed for optimal tree-shaking. This guide explains how to import modules efficiently to minimize bundle size.

## Package Configuration

Arc is configured for tree-shaking:

```json
{
  "sideEffects": false,
  "type": "module"
}
```

The build uses `tsup` with:
- ESM-only output
- `treeshake: true`
- Subpath exports for granular imports

## Import Strategies

### Recommended: Subpath Imports

For best tree-shaking, import from specific subpaths:

```typescript
// BEST - Only loads what you need
import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { requireAuth, requireRoles } from '@classytic/arc/permissions';
import { createTestApp } from '@classytic/arc/testing';
import { createApp } from '@classytic/arc/factory';
import { PrismaQueryParser } from '@classytic/arc/adapters';
```

### Acceptable: Main Entry Point

Importing from the main entry works but may include more code:

```typescript
// OK - Common items are available
import {
  defineResource,
  createMongooseAdapter,
  allowPublic,
  requireAuth,
} from '@classytic/arc';
```

### Avoid: Wildcard Imports

Never use wildcard imports:

```typescript
// BAD - Imports everything, defeats tree-shaking
import * as arc from '@classytic/arc';
```

## Available Subpaths

| Subpath | Purpose | Example Exports |
|---------|---------|-----------------|
| `@classytic/arc` | Core API | `defineResource`, `createMongooseAdapter`, `BaseController` |
| `@classytic/arc/permissions` | Permission functions | `allowPublic`, `requireAuth`, `requireRoles`, `allOf`, `anyOf` |
| `@classytic/arc/adapters` | Database adapters | `MongooseAdapter`, `PrismaAdapter`, `PrismaQueryParser` |
| `@classytic/arc/presets` | Preset functions | `softDeletePreset`, `slugLookupPreset`, `multiTenantPreset` |
| `@classytic/arc/factory` | App creation | `createApp`, `ArcFactory` |
| `@classytic/arc/testing` | Test utilities | `createTestApp`, `TestHarness`, mocks |
| `@classytic/arc/hooks` | Hook system | `hookSystem`, `beforeCreate`, `afterUpdate` |
| `@classytic/arc/events` | Event system | `eventPlugin`, `MemoryEventTransport` |
| `@classytic/arc/plugins` | Fastify plugins | `healthPlugin`, `requestIdPlugin` |
| `@classytic/arc/utils` | Utilities | `ArcError`, `NotFoundError`, `createStateMachine` |
| `@classytic/arc/org` | Organization utils | `orgScopePlugin`, `orgGuard` |
| `@classytic/arc/audit` | Audit trail | `auditPlugin`, `MemoryAuditStore` |
| `@classytic/arc/idempotency` | Idempotency | `idempotencyPlugin`, stores |
| `@classytic/arc/registry` | Resource registry | `resourceRegistry` |
| `@classytic/arc/types` | Type definitions | All TypeScript types |
| `@classytic/arc/cli` | CLI tools | `generate` function |
| `@classytic/arc/policies` | Policy system | `PolicyInterface` |
| `@classytic/arc/migrations` | Migrations | Migration utilities |
| `@classytic/arc/docs` | Documentation | OpenAPI generation |

## Example: Minimal Resource Definition

```typescript
// Optimal imports for a basic resource
import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { allowPublic, requireRoles } from '@classytic/arc/permissions';

// Only imports ~15KB instead of full 100KB+ bundle
export const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: Product, repository: productRepo }),
  permissions: {
    list: allowPublic(),
    create: requireRoles(['admin']),
  },
});
```

## Example: Full-Featured Resource

```typescript
// Imports for a feature-rich resource
import { defineResource, createMongooseAdapter, BaseController } from '@classytic/arc';
import { allowPublic, requireAuth, requireRoles, requireOwnership } from '@classytic/arc/permissions';
import { beforeCreate, afterCreate } from '@classytic/arc/hooks';
import { eventPlugin, createEvent } from '@classytic/arc/events';

// Production app with factory
import { createApp } from '@classytic/arc/factory';
import { healthPlugin, requestIdPlugin } from '@classytic/arc/plugins';
```

## Example: Testing Only

```typescript
// For test files - import only testing utilities
import { createTestApp, createMockUser, TestHarness } from '@classytic/arc/testing';
```

## Verifying Tree-Shaking

### With Bundler Analysis

If using Vite, webpack, or similar:

```bash
# Vite
npx vite build --report

# Webpack
npx webpack-bundle-analyzer stats.json
```

### With esbuild

```bash
npx esbuild your-app.ts --bundle --analyze
```

## Side Effects

Arc has `"sideEffects": false` in package.json, meaning:

1. **No global mutations** on import
2. **No side effects** from unused exports
3. **Bundlers can safely eliminate** unused code

### What This Means

```typescript
// This import does NOTHING if you don't use auditPlugin
import { auditPlugin } from '@classytic/arc/audit';

// Bundler will eliminate the import entirely
```

## TypeScript Configuration

For best results, ensure your `tsconfig.json` has:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true
  }
}
```

## Common Patterns

### Pattern 1: Resource Module

```typescript
// modules/product/product.resource.ts
import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import { Product } from './product.model.js';
import { productRepository } from './product.repository.js';

export const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: Product, repository: productRepository }),
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
});
```

### Pattern 2: Application Bootstrap

```typescript
// app.ts
import { createApp } from '@classytic/arc/factory';
import { productResource } from './modules/product/product.resource.js';
import { userResource } from './modules/user/user.resource.js';

export async function bootstrap() {
  return createApp({
    preset: 'production',
    auth: { jwt: { secret: process.env.JWT_SECRET! } },
    plugins: async (fastify) => {
      await fastify.register(productResource.toPlugin());
      await fastify.register(userResource.toPlugin());
    },
  });
}
```

### Pattern 3: Test Setup

```typescript
// tests/product.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from '@classytic/arc/testing';

describe('Product API', () => {
  let app;

  beforeAll(async () => {
    app = await createTestApp({
      auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
    });
  });

  afterAll(() => app?.close());

  // tests...
});
```

## Bundle Size Impact

| Import Strategy | Approximate Size |
|-----------------|------------------|
| Full barrel (`import * as arc`) | ~150KB |
| Main entry (common imports) | ~50KB |
| Subpath imports (minimal) | ~15KB |

These are approximate and depend on your specific usage.

## Summary

1. **Use subpath imports** for granular control
2. **Avoid wildcard imports** (`import *`)
3. **Group related imports** from the same subpath
4. **Trust the bundler** - unused code is eliminated
5. **Use analysis tools** to verify bundle size
