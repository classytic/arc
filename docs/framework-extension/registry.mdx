# Registry Module

Runtime introspection and resource discovery.

## Overview

Arc maintains a central registry of all defined resources, enabling:
- API discovery
- Runtime introspection
- DevTools integration
- OpenAPI generation

## Programmatic Access

```typescript
import { resourceRegistry } from '@classytic/arc/registry';

// Get all resources
const resources = resourceRegistry.getAll();

// Get specific resource
const product = resourceRegistry.get('product');

// Get statistics
const stats = resourceRegistry.getStats();
// {
//   totalResources: 12,
//   byModule: { catalog: 3, inventory: 2, commerce: 5 },
//   presetUsage: { softDelete: 8, slugLookup: 5 },
//   totalRoutes: 45,
//   totalEvents: 10
// }
```

## Introspection Plugin

Exposes registry via HTTP endpoints.

```typescript
import { introspectionPlugin } from '@classytic/arc/registry';

await fastify.register(introspectionPlugin, {
  prefix: '/_meta',
  authRoles: ['admin'],  // Protect in production
  enabled: true,
});
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `/_meta/resources` | List all resources |
| `/_meta/resources/:name` | Get specific resource |
| `/_meta/stats` | Registry statistics |

### Response Example

```json
// GET /_meta/resources
{
  "resources": [
    {
      "name": "product",
      "displayName": "Products",
      "prefix": "/products",
      "module": "catalog",
      "presets": ["softDelete", "slugLookup"],
      "permissions": {
        "list": [],
        "create": ["admin"]
      },
      "routes": [
        { "method": "GET", "path": "/", "operation": "list" },
        { "method": "POST", "path": "/", "operation": "create" },
        { "method": "GET", "path": "/:id", "operation": "get" },
        { "method": "GET", "path": "/slug/:slug", "operation": "getBySlug" }
      ],
      "events": ["product:created", "product:updated"]
    }
  ]
}
```

## Registry Entry Structure

```typescript
interface RegistryEntry {
  name: string;
  displayName: string;
  tag: string;
  prefix: string;
  module: string | null;
  model?: Model<Document>;
  repository: CrudRepository;
  controller: CrudController;
  permissions: AuthConfig;
  presets: string[];
  additionalRoutes: Array<{
    method: string;
    path: string;
    handler: string;
    summary?: string;
    authRoles?: string[];
  }>;
  events: string[];
  registeredAt: string;
  disableDefaultRoutes?: boolean;
}
```

## Auto-Registration

Resources are auto-registered when using `defineResource`:

```typescript
const product = defineResource({
  name: 'product',
  module: 'catalog',  // Optional grouping
  // ...
});

// Automatically registered in resourceRegistry
```

## Skip Registration

For testing or dynamic resources:

```typescript
const testResource = defineResource({
  name: 'test',
  skipRegistry: true,  // Don't add to global registry
  // ...
});
```

## Use Cases

### API Discovery

```typescript
// Build navigation from registry
const nav = resourceRegistry.getAll().map(r => ({
  label: r.displayName,
  path: r.prefix,
  operations: r.additionalRoutes.length + 5, // CRUD + additional
}));
```

### Permission Auditing

```typescript
// Find all public routes
const publicRoutes = resourceRegistry.getAll()
  .filter(r => r.permissions.list?.length === 0)
  .map(r => `${r.prefix} (list)`);
```

### DevTools

```typescript
// Hot-reload detection
const resourceNames = new Set(resourceRegistry.getAll().map(r => r.name));
if (resourceNames.has(newResource.name)) {
  console.warn(`Resource ${newResource.name} already registered`);
}
```
