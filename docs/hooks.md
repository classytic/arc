# Hooks Module

Lifecycle hooks for intercepting CRUD operations within your service.

> **Note:** For cross-service communication and external integration, use the [Events module](./events.md) instead. Hooks are for internal domain logic; Events are for the public integration layer.

## Quick Start

```typescript
import { beforeCreate, afterCreate, afterUpdate } from '@classytic/arc/hooks';

// Validate before creating
beforeCreate('product', async (context) => {
  const { data } = context;
  if (data.price < 0) {
    throw new Error('Price cannot be negative');
  }
});

// Generate slug after creating
afterCreate('product', async (context) => {
  const { result } = context;
  await generateSearchIndex(result);
});

// Sync inventory after update
afterUpdate('product', async (context) => {
  const { result } = context;
  // Check if quantity field exists to sync inventory
  if (result.quantity !== undefined) {
    await syncInventory(result._id);
  }
});
```

## Available Hooks

| Hook | Phase | Description |
|------|-------|-------------|
| `beforeCreate` | before | Before item is created |
| `afterCreate` | after | After item is created |
| `beforeUpdate` | before | Before item is updated |
| `afterUpdate` | after | After item is updated |
| `beforeDelete` | before | Before item is deleted |
| `afterDelete` | after | After item is deleted |

## Hook Context

```typescript
interface HookContext {
  resource: string;      // Resource name (e.g., 'product')
  operation: string;     // 'create' | 'update' | 'delete' | 'read' | 'list'
  phase: string;         // 'before' | 'after'
  data?: any;            // Input data (before hooks)
  result?: any;          // Output data (after hooks)
  user?: UserBase;       // Authenticated user
  context?: RequestContext; // Request context (org, tenant, etc.)
  meta?: any;            // Additional metadata
}
```

## Hook System API

For advanced usage:

```typescript
import { hookSystem } from '@classytic/arc/hooks';

// Register hook with object parameter
const unsubscribe = hookSystem.register({
  resource: 'product',
  operation: 'create',
  phase: 'after',
  handler: async (context) => { /* ... */ },
  priority: 5,  // Lower = runs first (default: 10)
});

// Or use positional arguments (both work)
hookSystem.register('product', 'create', 'after', async (context) => {
  // handler logic
}, 5);

// Unregister when done
unsubscribe();

// Manually execute hooks
await hookSystem.executeBefore('product', 'create', data, { user, context });
await hookSystem.executeAfter('product', 'create', result, { user, context });
```

## Execution Order

1. Hooks run in priority order (lower priority = runs first)
2. Same priority = registration order
3. All hooks run (no short-circuit on error by default)
4. Errors in after hooks are logged but don't fail the request

## Use Cases

**Validation:**
```typescript
beforeCreate('order', async ({ data }) => {
  const inventory = await checkInventory(data.items);
  if (!inventory.available) {
    throw new Error('Items out of stock');
  }
});
```

**Side Effects:**
```typescript
afterCreate('order', async ({ result }) => {
  await sendOrderConfirmation(result.customer, result);
  await reserveInventory(result.items);
});
```

**Audit:**
```typescript
afterUpdate('product', async ({ result, user, meta }) => {
  await auditLog.create({
    action: 'product.updated',
    resourceId: result._id,
    updatedFields: meta?.updatedFields || Object.keys(result),
    userId: user?._id,
  });
});
```

**Cache Invalidation:**
```typescript
afterUpdate('category', async ({ result }) => {
  await cache.invalidate(`category:${result._id}`);
  await cache.invalidate('category:tree');
});
```
