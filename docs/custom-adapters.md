# Custom Adapters

Learn how to create adapters for any database or ORM.

---

## What is an Adapter?

Adapters provide a **database-agnostic interface** between Arc and your data layer. They allow Arc to work with any database (MongoDB, PostgreSQL, MySQL, etc.) or ORM (Mongoose, Prisma, Drizzle, TypeORM, etc.).

**An adapter provides:**
1. **Repository**: CRUD operations (required)
2. **Schema metadata**: Field types, relations (optional)
3. **OpenAPI schemas**: Auto-generated documentation (optional)

---

## The DataAdapter Interface

```typescript
interface DataAdapter<TDoc = any> {
  /** Repository for CRUD operations (required) */
  repository: CrudRepository<TDoc>;
  
  /** Get schema metadata for introspection (optional) */
  getSchemaMetadata?(): SchemaMetadata;
  
  /** Generate OpenAPI schemas (optional) */
  generateSchemas?(schemaOptions?: RouteSchemaOptions): OpenApiSchemas | null;
}
```

### Required: `repository`

Every adapter must provide a repository implementing `CrudRepository`:

```typescript
interface CrudRepository<TDoc> {
  getAll(options: QueryOptions): Promise<PaginatedResult<TDoc> | TDoc[]>;
  getById(id: string, options?: QueryOptions): Promise<TDoc | null>;
  create(data: Partial<TDoc>, options?: ServiceContext): Promise<TDoc>;
  update(id: string, data: Partial<TDoc>, options?: ServiceContext): Promise<TDoc | null>;
  delete(id: string, options?: ServiceContext): Promise<boolean | { success: boolean }>;
}
```

### Optional: `getSchemaMetadata()`

Provides field and relation metadata for introspection:

```typescript
interface SchemaMetadata {
  name: string;
  fields: Record<string, FieldMetadata>;
  relations?: RelationMetadata[];
}
```

### Optional: `generateSchemas()`

Auto-generates OpenAPI schemas from your database schema:

```typescript
interface OpenApiSchemas {
  create?: { body: AnyRecord };
  update?: { body: AnyRecord };
  response?: AnyRecord;
  listQuery?: AnyRecord;
}
```

---

## Example 1: Minimal Adapter (Repository Only)

The simplest adapter just wraps a repository:

```typescript
import { defineResource } from '@classytic/arc';
import type { DataAdapter } from '@classytic/arc/adapters';

// Your repository (any implementation)
class UserRepository {
  async getAll() { /* ... */ }
  async getById(id) { /* ... */ }
  async create(data) { /* ... */ }
  async update(id, data) { /* ... */ }
  async delete(id) { /* ... */ }
}

const userRepo = new UserRepository();

// Minimal adapter
const simpleAdapter: DataAdapter = {
  repository: userRepo,
};

// Use in resource
defineResource({
  name: 'user',
  adapter: simpleAdapter,
});
```

---

## Example 2: Prisma Adapter (Full Implementation)

```typescript
import { PrismaClient } from '@prisma/client';
import type { DataAdapter, SchemaMetadata } from '@classytic/arc/adapters';

const prisma = new PrismaClient();

// Prisma Repository
class PrismaUserRepository {
  async getAll(options) {
    const { page = 1, limit = 20, filters = {} } = options;
    
    const [docs, total] = await Promise.all([
      prisma.user.findMany({
        where: filters,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where: filters }),
    ]);

    return {
      docs,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    };
  }

  async getById(id) {
    return prisma.user.findUnique({ where: { id } });
  }

  async create(data) {
    return prisma.user.create({ data });
  }

  async update(id, data) {
    return prisma.user.update({ where: { id }, data });
  }

  async delete(id) {
    await prisma.user.delete({ where: { id } });
    return true;
  }
}

// Prisma Adapter
export function createPrismaAdapter(options: {
  model: string;
  repository: any;
  dmmf?: any;
}): DataAdapter {
  return {
    repository: options.repository,
    
    getSchemaMetadata() {
      // Extract from Prisma DMMF (Data Model Meta Format)
      const model = options.dmmf?.datamodel.models.find(
        m => m.name === options.model
      );
      
      if (!model) return null;
      
      const fields = {};
      for (const field of model.fields) {
        fields[field.name] = {
          name: field.name,
          type: field.type,
          required: field.isRequired,
          ref: field.relationName,
        };
      }
      
      return {
        name: model.name,
        fields,
        relations: model.fields
          .filter(f => f.relationName)
          .map(f => ({
            name: f.name,
            type: f.isList ? 'hasMany' : 'belongsTo',
            relatedModel: f.type,
          })),
      };
    },
    
    generateSchemas(schemaOptions) {
      // Generate OpenAPI schemas from Prisma schema
      const model = options.dmmf?.datamodel.models.find(
        m => m.name === options.model
      );
      
      if (!model) return null;
      
      const properties = {};
      const required = [];
      
      for (const field of model.fields) {
        if (field.relationName) continue; // Skip relations
        
        properties[field.name] = prismaTypeToOpenApi(field);
        
        if (field.isRequired && !field.hasDefaultValue) {
          required.push(field.name);
        }
      }
      
      return {
        create: {
          body: {
            type: 'object',
            properties: excludeFields(properties, ['id', 'createdAt', 'updatedAt']),
            required,
          },
        },
        update: {
          body: {
            type: 'object',
            properties: excludeFields(properties, ['id', 'createdAt', 'updatedAt']),
          },
        },
        response: {
          type: 'object',
          properties,
        },
      };
    },
  };
}

// Helper to convert Prisma types to OpenAPI
function prismaTypeToOpenApi(field: any) {
  const typeMap = {
    String: { type: 'string' },
    Int: { type: 'integer' },
    Float: { type: 'number' },
    Boolean: { type: 'boolean' },
    DateTime: { type: 'string', format: 'date-time' },
    Json: { type: 'object' },
  };
  
  return typeMap[field.type] || { type: 'string' };
}

function excludeFields(obj: any, fields: string[]) {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !fields.includes(key))
  );
}

// Usage
import { Prisma } from '@prisma/client';

const userAdapter = createPrismaAdapter({
  model: 'User',
  repository: new PrismaUserRepository(),
  dmmf: Prisma.dmmf,
});

defineResource({
  name: 'user',
  adapter: userAdapter,
});
```

---

## Example 3: Drizzle ORM Adapter

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { users } from './schema';
import type { DataAdapter } from '@classytic/arc/adapters';

const db = drizzle(process.env.DATABASE_URL);

// Drizzle Repository
class DrizzleUserRepository {
  async getAll(options) {
    const { page = 1, limit = 20, filters = {} } = options;
    const offset = (page - 1) * limit;

    const [docs, [{ count }]] = await Promise.all([
      db.select().from(users).limit(limit).offset(offset),
      db.select({ count: sql`count(*)` }).from(users),
    ]);

    return {
      docs,
      page,
      limit,
      total: Number(count),
      pages: Math.ceil(Number(count) / limit),
      hasNext: page * limit < Number(count),
      hasPrev: page > 1,
    };
  }

  async getById(id) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || null;
  }

  async create(data) {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  }

  async update(id, data) {
    const [user] = await db
      .update(users)
      .set(data)
      .where(eq(users.id, id))
      .returning();
    return user || null;
  }

  async delete(id) {
    await db.delete(users).where(eq(users.id, id));
    return true;
  }
}

// Drizzle Adapter
export function createDrizzleAdapter(options: {
  table: any;
  repository: any;
}): DataAdapter {
  return {
    repository: options.repository,
    
    getSchemaMetadata() {
      // Extract from Drizzle table schema
      const columns = Object.entries(options.table);
      const fields = {};
      
      for (const [name, column] of columns) {
        fields[name] = {
          name,
          type: (column as any).dataType,
          required: !(column as any).notNull,
        };
      }
      
      return {
        name: options.table._.name,
        fields,
        relations: [],
      };
    },
  };
}

// Usage
const userAdapter = createDrizzleAdapter({
  table: users,
  repository: new DrizzleUserRepository(),
});
```

---

## Example 4: SQL.js (In-Memory SQLite)

```typescript
import initSqlJs from 'sql.js';
import type { DataAdapter } from '@classytic/arc/adapters';

const SQL = await initSqlJs();
const db = new SQL.Database();

// Create table
db.run(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// SQL.js Repository
class SqlJsUserRepository {
  async getAll(options) {
    const { page = 1, limit = 20 } = options;
    const offset = (page - 1) * limit;

    const results = db.exec(
      `SELECT * FROM users LIMIT ${limit} OFFSET ${offset}`
    );
    const countResult = db.exec(`SELECT COUNT(*) as count FROM users`);

    const docs = results[0]?.values.map(row => ({
      id: row[0],
      name: row[1],
      email: row[2],
      createdAt: row[3],
    })) || [];

    const total = countResult[0]?.values[0][0] || 0;

    return {
      docs,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    };
  }

  async getById(id) {
    const result = db.exec(`SELECT * FROM users WHERE id = ?`, [id]);
    if (!result[0]?.values[0]) return null;
    
    const row = result[0].values[0];
    return {
      id: row[0],
      name: row[1],
      email: row[2],
      createdAt: row[3],
    };
  }

  async create(data) {
    db.run(
      `INSERT INTO users (name, email) VALUES (?, ?)`,
      [data.name, data.email]
    );
    
    const result = db.exec(`SELECT last_insert_rowid()`);
    const id = result[0].values[0][0];
    return this.getById(id);
  }

  async update(id, data) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = Object.values(data);
    
    db.run(`UPDATE users SET ${sets} WHERE id = ?`, [...values, id]);
    return this.getById(id);
  }

  async delete(id) {
    db.run(`DELETE FROM users WHERE id = ?`, [id]);
    return true;
  }
}

// Simple adapter
const sqliteAdapter: DataAdapter = {
  repository: new SqlJsUserRepository(),
};
```

---

## Type Safety Tips

### Use Type Inference Helpers

```typescript
import type { InferMongooseDoc, InferRepoDoc } from '@classytic/arc/adapters';

// Infer document type from model
const ProductModel = mongoose.model('Product', productSchema);
type ProductDoc = InferMongooseDoc<typeof ProductModel>;

// Infer document type from repository
const productRepo = new ProductRepository();
type RepoDoc = InferRepoDoc<typeof productRepo>;

// No 'as any' needed!
const adapter = createMongooseAdapter({
  model: ProductModel,
  repository: productRepo,
});
```

### Create Type-Safe Options

```typescript
import { createAdapterOptions } from '@classytic/arc/adapters';

// Runtime validation + type inference
const options = createAdapterOptions(ProductModel, productRepo);
// TypeScript infers ProductDocument automatically
```

---

## Testing Your Adapter

```typescript
import { describe, it, expect } from 'vitest';
import { createTestApp } from '@classytic/arc/testing';

describe('Custom Adapter', () => {
  it('should implement CrudRepository interface', () => {
    const adapter = createMyAdapter(/* ... */);
    
    expect(adapter.repository).toBeDefined();
    expect(typeof adapter.repository.getAll).toBe('function');
    expect(typeof adapter.repository.getById).toBe('function');
    expect(typeof adapter.repository.create).toBe('function');
    expect(typeof adapter.repository.update).toBe('function');
    expect(typeof adapter.repository.delete).toBe('function');
  });
  
  it('should handle CRUD operations', async () => {
    const adapter = createMyAdapter(/* ... */);
    
    // Create
    const created = await adapter.repository.create({ name: 'Test' });
    expect(created).toHaveProperty('id');
    
    // Read
    const found = await adapter.repository.getById(created.id);
    expect(found.name).toBe('Test');
    
    // Update
    const updated = await adapter.repository.update(created.id, { name: 'Updated' });
    expect(updated.name).toBe('Updated');
    
    // Delete
    const deleted = await adapter.repository.delete(created.id);
    expect(deleted).toBe(true);
  });
});
```

---

## Best Practices

### 1. **Validate Inputs**

```typescript
export function createMyAdapter(options: MyAdapterOptions): DataAdapter {
  if (!options.connection) {
    throw new TypeError('connection is required');
  }
  
  if (!options.repository) {
    throw new TypeError('repository is required');
  }
  
  return { repository: options.repository };
}
```

### 2. **Handle Errors Gracefully**

```typescript
getSchemaMetadata() {
  try {
    // Extract metadata
    return { name: 'User', fields: {} };
  } catch (error) {
    console.warn('Failed to extract schema metadata:', error);
    return null; // Graceful fallback
  }
}
```

### 3. **Support Both Pagination Styles**

Arc accepts both array and paginated results:

```typescript
async getAll(options) {
  // Return array (simple)
  return [{ id: 1 }, { id: 2 }];
  
  // OR return paginated result (recommended)
  return {
    docs: [{ id: 1 }, { id: 2 }],
    page: 1,
    limit: 20,
    total: 2,
    pages: 1,
    hasNext: false,
    hasPrev: false,
  };
}
```

### 4. **Document Your Adapter**

```typescript
/**
 * Create a MyDB adapter for Arc
 *
 * @example
 * const adapter = createMyDbAdapter({
 *   connection: myDbClient,
 *   repository: userRepository,
 * });
 *
 * defineResource({
 *   name: 'user',
 *   adapter,
 * });
 */
export function createMyDbAdapter(/* ... */) {
  // ...
}
```

---

## Community Adapters

Submit your adapter to the Arc community:

1. **Publish to npm:** `@arc-adapter/your-db`
2. **Add docs:** README with usage examples
3. **Submit PR:** Add to Arc's adapter registry

**Examples:**
- `@arc-adapter/dynamodb` - AWS DynamoDB
- `@arc-adapter/firebase` - Firebase Firestore
- `@arc-adapter/supabase` - Supabase (PostgreSQL)
- `@arc-adapter/fauna` - FaunaDB

---

## Need Help?

- Check [examples/framework-adapters.ts](../examples/framework-adapters.ts)
- Ask in [GitHub Discussions](https://github.com/classytic/arc/discussions)
- Open an [issue](https://github.com/classytic/arc/issues) if you find bugs
